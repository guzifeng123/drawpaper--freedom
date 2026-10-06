import type {
  BlockType,
  EditorStoreApi,
  Edge,
  MeasuredSize,
} from '@drawpaper/core';
import { buildChildCountMap } from '@drawpaper/core';
import type {
  ConflictResolutionInput,
  EditorApi,
  EditorSnapshot,
  LayoutGhost,
  PendingConflicts,
} from '@/editor/editor-api';
import type { ConflictBridge } from './conflict-bridge';
import { getWiringUi } from './ui-store';
import { requestDeleteNodes } from './block-delete-guard';
import { ingestImageFile } from '@/storage/image-pipeline';

/**
 * createEditorApi —— 把 C 的真实 EditorStore 适配为 D 的结构型 EditorApi。
 *
 * 接缝整形（store ↔ EditorSnapshot 的形状差异）：
 *  - layoutPreview：store 只给 {x,y}，这里按 measuredSizes/节点尺寸补成 LayoutGhost{x,y,width,height}；
 *  - pendingConflicts：store 叫 triggerEdgeIds，EditorApi 叫 provisionalEdgeIds，多父/成环子结构一致；
 *  - lastFocus：store 用 nonce，EditorApi 用 ts，直接把 nonce 当 ts（每次 ++ 即触发动画）；
 *  - prefs：store.snapToGrid → EditorApi.prefs.gridSnap。
 *
 * getState() 必须返回「引用稳定」的快照（useSyncExternalStore 要求）：
 * store 每次 set 都令缓存失效，重算一次；两次通知之间返回同一对象引用，
 * 避免 "Maximum update depth" 死循环。
 */
export function createEditorApi(store: EditorStoreApi, bridge: ConflictBridge): EditorApi {
  let cached: EditorSnapshot | null = null;
  store.subscribe(() => {
    cached = null;
  });

  // 子节点数映射按 edges 引用缓存：viewport/measuredSizes/选择等不改变 edges 的通知
  // 不必重扫 E 条边。edges 引用变化（增删边/切换文档）才重建。
  let cachedEdgesRef: Edge[] | null = null;
  let cachedChildCount: Record<string, number> = {};

  // Wave7 robustness（10k 块 TTI）：批量合并 ResizeObserver 尺寸上报。
  // 大文档首屏 N 个节点各自挂载时会同步 fire report()，若每次都 store.set
  // 会触发 N 次快照失效 + rfNodes 重算（O(N²)）。这里把一帧内的上报合并成
  // 一次 store.set，语义不变（同一 id 后报覆盖先报）。
  const pendingSizes: Record<string, MeasuredSize> = {};
  let sizeFlushScheduled = false;
  const flushMeasuredSizes = () => {
    sizeFlushScheduled = false;
    const pending = pendingSizes;
    if (Object.keys(pending).length === 0) return;
    for (const k of Object.keys(pending)) delete pending[k];
    const cur = store.getState().measuredSizes;
    const merged: Record<string, MeasuredSize> = { ...cur };
    for (const [id, p] of Object.entries(pending)) {
      const prev = merged[id];
      merged[id] = {
        width: p.width ?? prev?.width ?? 260,
        height: p.height ?? prev?.height ?? 80,
      };
    }
    store.getState().setMeasuredSizes(merged);
  };
  const scheduleSizeFlush = () => {
    if (sizeFlushScheduled) return;
    sizeFlushScheduled = true;
    // rAF 对齐 React 提交节奏；无 rAF（测试）退化为微任务。
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flushMeasuredSizes);
    else Promise.resolve().then(flushMeasuredSizes);
  };

  const buildSnapshot = (): EditorSnapshot => {
    const s = store.getState();

    let layoutPreview: Record<string, LayoutGhost> | null = null;
    if (s.layoutPreview) {
      layoutPreview = {};
      for (const [id, pos] of Object.entries(s.layoutPreview)) {
        const node = s.doc.nodes.find((n) => n.id === id);
        const m = s.measuredSizes[id];
        layoutPreview[id] = {
          x: pos.x,
          y: pos.y,
          width: m?.width ?? node?.width ?? 260,
          height: m?.height ?? node?.height ?? 80,
        };
      }
    }

    const pending: PendingConflicts | null = s.pendingConflicts
      ? {
          provisionalEdgeIds: s.pendingConflicts.triggerEdgeIds,
          multiParents: s.pendingConflicts.multiParents,
          cycles: s.pendingConflicts.cycles,
        }
      : null;

    if (s.doc.edges !== cachedEdgesRef) {
      cachedEdgesRef = s.doc.edges;
      cachedChildCount = buildChildCountMap(s.doc.edges);
    }

    return {
      doc: s.doc,
      selection: s.selection,
      editingNodeId: s.editingNodeId,
      mode: s.mode,
      viewport: s.viewport,
      layoutPreview,
      pendingConflicts: pending,
      searchHighlight: s.searchHighlight,
      saveState: s.saveState,
      prefs: { gridSnap: s.prefs.snapToGrid },
      lastFocus: s.lastFocus ? { nodeId: s.lastFocus.nodeId, ts: s.lastFocus.nonce } : null,
      historyEvent: s.historyEvent,
      // Wave4：聚焦分支 / 标签筛选 / 手动固定节点。
      focusNodeId: s.focusNodeId,
      tagFilter: { mode: s.tagFilter.match, tagIds: s.tagFilter.tagIds },
      manualFixed: s.manuallyMoved,
      // 一次扫边预计算子节点数；高频组件（折叠角标）O(1) 读取。
      childCount: cachedChildCount,
    };
  };

  const api: EditorApi = {
    getState: (): EditorSnapshot => {
      if (cached) return cached;
      cached = buildSnapshot();
      return cached;
    },
    subscribe: (fn) => store.subscribe(fn),

    // ---- 节点 CRUD ----
    addNode: (type: BlockType, x, y) => store.getState().addNode(type, x, y),
    addNodes: (nodes) => store.getState().addNodes(nodes),
    addImageBlock: (dataUrl, x, y) => store.getState().addImageBlock(dataUrl, x, y),
    ingestImage: async (file, x, y) =>
      ingestImageFile(
        {
          // store.putImageAsset 已在 OPFS 不可用时返回空 src（assetRef=''）。
          putImageAsset: async (blob) => {
            const r = await store.getState().putImageAsset(blob);
            return { assetRef: r.assetRef ?? r.src ?? '' };
          },
          addImageBlock: (src, bx, by) => store.getState().addImageBlock(src, bx, by),
        },
        file,
        x,
        y,
      ),
    // Wave7 P2.1：删块先走反链影响守卫——无影响直删，有影响弹确认框。
    deleteNodes: (ids) => void requestDeleteNodes(store, ids),
    updateContent: (id, data) => store.getState().updateContent(id, data),
    setBlockType: (id, type) => store.getState().setBlockType(id, type),
    moveNode: (id, x, y) => store.getState().moveNode(id, x, y),
    resizeNode: (id, w, h) => store.getState().resizeNode(id, w, h),
    setMeasuredSizes: (patches) => {
      // EditorApi 允许只报 height；store.measuredSizes 需要完整 {width,height}。
      // Wave7：先入待合并缓冲，rAF 对齐后一次性 flush（避免大文档首屏 N 次 store.set）。
      for (const [id, p] of Object.entries(patches)) {
        pendingSizes[id] = {
          width: p.width ?? pendingSizes[id]?.width ?? 260,
          height: p.height ?? pendingSizes[id]?.height ?? 80,
        };
      }
      scheduleSizeFlush();
    },

    // ---- 边 ----
    addEdge: (source, target, opts) => store.getState().addEdge(source, target, opts),
    deleteEdge: (id) => store.getState().deleteEdge(id),
    setEdgeColor: (id, color) => store.getState().setEdgeColor(id, color),
    setEdgeLabel: (id, label) => store.getState().setEdgeLabel(id, label),
    setEdgePoints: (id, points) => store.getState().setEdgePoints(id, points),
    clearEdgesPoints: (ids) => store.getState().clearEdgesPoints(ids),
    reverseEdge: (id) => store.getState().reverseEdge(id),

    // ---- 导图键盘 ----
    tabAddChild: () => store.getState().tabAddChild(),
    enterAddSibling: () => store.getState().enterAddSibling(),
    shiftTabDemote: () => store.getState().shiftTabDemote(),

    // ---- 块属性 ----
    togglePin: (id) => store.getState().togglePin(id),
    toggleCollapse: (id) => store.getState().toggleCollapse(id),
    toggleTodo: (id) => store.getState().toggleTodo(id),
    setBlockStyle: (id, patch) => store.getState().updateNodeStyle(id, patch),

    // ---- 选择 / 模式 / 编辑 / 视口 ----
    setSelection: (ids) => store.getState().setSelection([...ids]),
    setMode: (mode) => store.getState().setMode(mode),
    setEditingNode: (id) => store.getState().setEditingNode(id),
    setViewport: (vp) => store.getState().setViewport(vp),
    addManualPageBreak: (id, x, y) => store.getState().addManualPageBreak(id, x, y),
    removePageBreak: (id) => store.getState().removePageBreak(id),
    setPageBreaks: (breaks) => store.getState().setPageBreaks(breaks),

    // ---- 剪贴板 ----
    copy: () => store.getState().copy(),
    cut: () => store.getState().cut(),
    paste: () => store.getState().paste(),
    duplicate: () => store.getState().duplicate(),

    // ---- 撤销重做 ----
    undo: () => store.getState().undo(),
    redo: () => store.getState().redo(),

    // ---- 一键整理 ----
    previewLayout: () => store.getState().previewLayout(),
    confirmLayout: () => store.getState().confirmLayout(),
    cancelLayout: () => store.getState().cancelLayout(),

    // ---- 冲突 ----
    resolveConflicts: (r: ConflictResolutionInput) => bridge.resolve(r),
    cancelConflicts: () => bridge.cancel(),

    // ---- 偏好 ----
    setGridSnap: (on) => store.getState().setPrefs({ snapToGrid: on }),

    // ---- 面板接缝（纯 UI 态）----
    openSearch: () => getWiringUi().setSearchOpen(true),
    openExport: () => getWiringUi().setExportOpen(true),

    // ---- P1 聚焦 / 筛选（真实 store）----
    setFocusNode: (id) => store.getState().setFocusNode(id),
    setTagFilter: (filter) =>
      store.getState().setTagFilter({ tagIds: filter.tagIds, match: filter.mode }),

    // ---- Wave9 无障碍：飞块 + 键盘焦点 ----
    focusNode: (id) => store.getState().flyToNode(id),

    // ---- P1 附件上传（OPFS 资产管线）----
    putImageAsset: async (file) => {
      const r = await store.getState().putImageAsset(file);
      // OPFS 不可用/写失败时 core 返回空 src（assetRef 为空）。
      // 接线层降级为 dataURL 内联：附件内容写进文档 JSON，刷新不丢。
      // （不动 opfs.ts 生产代码；dataURL 仅在 OPFS 不可用时出现。）
      const assetRef = r.assetRef ?? r.src;
      if (assetRef) return { assetRef, name: file.name, size: file.size };
      const dataUrl = await readFileAsDataURL(file);
      return { assetRef: dataUrl, name: file.name, size: file.size };
    },

    // ---- 保存 ----
    save: () => store.getState().requestSave(),
  };

  return api;
}

/** File → dataURL（OPFS 不可用时附件内联降级用）。 */
function readFileAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}
