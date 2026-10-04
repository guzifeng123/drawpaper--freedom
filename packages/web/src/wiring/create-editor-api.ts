import type {
  BlockType,
  EditorStoreApi,
  MeasuredSize,
} from '@drawpaper/core';
import type {
  ConflictResolutionInput,
  EditorApi,
  EditorSnapshot,
  LayoutGhost,
  PendingConflicts,
} from '@/editor/editor-api';
import type { ConflictBridge } from './conflict-bridge';
import { getWiringUi } from './ui-store';

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
    deleteNodes: (ids) => store.getState().deleteNodes(ids),
    updateContent: (id, data) => store.getState().updateContent(id, data),
    setBlockType: (id, type) => store.getState().setBlockType(id, type),
    moveNode: (id, x, y) => store.getState().moveNode(id, x, y),
    resizeNode: (id, w, h) => store.getState().resizeNode(id, w, h),
    setMeasuredSizes: (patches) => {
      // EditorApi 允许只报 height；store.measuredSizes 需要完整 {width,height}。
      // 以现有 measuredSizes 为底做合并，宽度缺省取已有值/默认。
      const cur = store.getState().measuredSizes;
      const merged: Record<string, MeasuredSize> = { ...cur };
      for (const [id, p] of Object.entries(patches)) {
        const prev = merged[id];
        merged[id] = {
          width: p.width ?? prev?.width ?? 260,
          height: p.height ?? prev?.height ?? 80,
        };
      }
      store.getState().setMeasuredSizes(merged);
    },

    // ---- 边 ----
    addEdge: (source, target, opts) => store.getState().addEdge(source, target, opts),
    deleteEdge: (id) => store.getState().deleteEdge(id),
    setEdgeColor: (id, color) => store.getState().setEdgeColor(id, color),
    setEdgeLabel: (id, label) => store.getState().setEdgeLabel(id, label),
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

    // ---- P1 附件上传（OPFS 资产管线）----
    putImageAsset: async (file) => {
      const r = await store.getState().putImageAsset(file);
      return { assetRef: r.assetRef ?? r.src, name: file.name, size: file.size };
    },

    // ---- 保存 ----
    save: () => store.getState().requestSave(),
  };

  return api;
}
