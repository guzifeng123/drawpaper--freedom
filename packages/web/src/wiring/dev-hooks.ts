import type { KBNoteDoc, DocRefLink } from '@drawpaper/core';
import { parseKBNote, KBNoteFileError, serializeKBNote } from '@drawpaper/core';
import { editorStore } from '@/store/editor-store';
import { getAsset, isOpfsAvailable } from '@/storage/opfs';
import { loadBacklinks } from '@/storage/backlinks';
import { mountOverviewDev, unmountOverviewDev } from '@/overview/dev-mount';

/**
 * DEV-only 测试钩子（window.__drawpaper__）。
 *
 * 仅在 import.meta.env.DEV 下挂载；生产构建不暴露（vite 静态替换为 false，
 * 整段 tree-shake）。供 Playwright e2e 批量灌数据 / 读状态 / 调 action，
 * 绕过 UI 操作以构造 500/2000 块性能夹具与标准验收样例。
 */

export interface DrawpaperDevHook {
  /** 整体替换当前文档（跳过 UI）。 */
  loadFixture(doc: KBNoteDoc): void;
  /** 读当前文档与视口快照。 */
  getState(): {
    doc: KBNoteDoc;
    viewport: { x: number; y: number; zoom: number };
    nodeCount: number;
    layoutUi: { scopeSelected: boolean; tighten: boolean };
    backupEnabled: boolean;
    searchResults: unknown[];
  };
  /** 按名调用白名单内的 store action。 */
  invoke(action: string, ...args: unknown[]): unknown;
  /** 常驻渲染离屏打印容器（e2e 截图/矢量 PDF 用）。 */
  setDebugSheets(on: boolean): void;
  // ---- Wave5b 附件 OPFS 检视（DEV-only，供 e2e 断言）----
  /** OPFS（navigator.storage.getDirectory）当前是否可用。 */
  opfsAvailable(): boolean;
  /** 当前文档登记的 assetRef 列表。 */
  listAssetRefs(): string[];
  /** 检查某 assetRef 的 blob 是否真的落在 OPFS 中。 */
  opfsHasAsset(ref: string): Promise<boolean>;
  // ---- Wave6a schema 迁移：e2e 走真实 parse+迁移路径 ----
  /**
   * 走真实 parseKBNote 路径导入一段 .kbnote 文本（供 e2e 注入 v1/v9 文件）。
   * 成功才 loadDoc；失败不替换当前文档，返回错误 kind。
   */
  importKbnoteText(text: string):
    | { ok: true; version: number; migrationNotes: string[] }
    | { ok: false; errorKind: string };
  // ---- Wave6b 跨文档双向链接：e2e 数据断言 ----
  /** 当前文档的规范化反链索引（保存时由 flushSave 从正文重建）。 */
  currentLinks(): DocRefLink[];
  /** 序列化当前文档为 .kbnote 文本。 */
  exportCurrent(): string;
  /** 查询指向 (docId, nodeId?) 的反链条目（来源文档/块标题）。 */
  backlinksTo(docId: string, nodeId?: string | null): Promise<unknown[]>;
  // ---- Wave6b 全局知识图谱总览（DEV-only，供 e2e 临时挂载；Wave7 由 App 正式挂载）----
  /** 临时挂载只读全局总览画布（全屏 fixed 容器）。 */
  mountOverviewDev(): void;
  /** 卸载临时总览容器。 */
  unmountOverviewDev(): void;
}

declare global {
  interface Window {
    __drawpaper__?: DrawpaperDevHook;
    /** App 在 DEV 下读取此标志，常驻打印容器供 e2e。 */
    __drawpaper_debugSheets?: boolean;
    /** 性能分阶段采样（仅 DEV）。 */
    __perfStages?: Record<string, number>;
  }
}

const WHITELIST = new Set([
  'loadDoc',
  'newDoc',
  'openDoc',
  'renameDoc',
  'setPageSettings',
  'setViewport',
  'setSelection',
  'setMeasuredSizes',
  'addNode',
  'addNodes',
  'addEdge',
  'deleteNodes',
  'undo',
  'redo',
  'previewLayout',
  'confirmLayout',
  'cancelLayout',
  'requestSave',
  'setSearchQuery',
  'setPrefs',
  'setMode',
  // Wave4 P1：供 e2e 断言标签筛选 / 聚焦 / 改父子 / AI 合入。
  'createTag',
  'setTagFilter',
  'clearTagFilter',
  'setFocusNode',
  'reparentNode',
  'reverseEdge',
  'setEdgePoints',
  'applyAISuggestions',
  'setLayoutMode',
  'setTighten',
  'setBackupEnabled',
  // Wave4b P1 e2e：快照 / 回收站 / 模板 / 文档生命周期 / 手动分页符。
  'listDocs',
  'deleteDoc',
  'createDocFromTemplate',
  'snapshotDoc',
  'restoreSnapshot',
  'listSnapshots',
  'listTrash',
  'restoreTrash',
  'purgeTrash',
  'emptyTrash',
  'addManualPageBreak',
  'removePageBreak',
]);

export function installDevHooks(): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === 'undefined') return;
  window.__drawpaper__ = {
    loadFixture(doc: KBNoteDoc) {
      const w = window as unknown as { __perfStages: Record<string, number | number[]> };
      const stages: Record<string, number | number[]> = {};
      w.__perfStages = stages;
      const t0 = performance.now();
      editorStore.getState().loadDoc(doc);
      stages.switchDocSync = performance.now() - t0;
      // Long Tasks 观察者
      const lt: number[] = [];
      const LO = (window as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
      if (LO) {
        try {
          const obs = new LO((list) => {
            for (const e of list.getEntries()) lt.push(Math.round(e.duration));
          });
          obs.observe({ entryTypes: ['longtask'] });
        } catch { /* noop */ }
      }
      // 两次 rAF 后 = React 首屏提交完成。
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          stages.afterRaf2 = performance.now() - t0;
          const settle = () => {
            stages.idle1 = performance.now() - t0;
            stages.longTasks = lt.slice(0, 20);
          };
          const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
          if (ric) ric(settle, { timeout: 3000 });
          else setTimeout(settle, 1000);
        }),
      );
    },
    getState() {
      const s = editorStore.getState();
      return {
        doc: s.doc,
        viewport: s.viewport,
        nodeCount: s.doc.nodes.length,
        layoutUi: { scopeSelected: s.layoutUi.scopeSelected, tighten: s.layoutUi.tighten },
        backupEnabled: s.backupEnabled,
        searchResults: s.searchResults,
        searchQuery: s.searchQuery,
      };
    },
    invoke(action: string, ...args: unknown[]) {
      if (!WHITELIST.has(action)) throw new Error(`dev-hook: action not whitelisted: ${action}`);
      const fn = (editorStore.getState() as unknown as Record<string, (...a: unknown[]) => unknown>)[action];
      if (typeof fn !== 'function') throw new Error(`dev-hook: no such action: ${action}`);
      return fn.apply(editorStore.getState(), args);
    },
    setDebugSheets(on: boolean) {
      window.__drawpaper_debugSheets = on;
    },
    opfsAvailable() {
      return isOpfsAvailable();
    },
    listAssetRefs() {
      return [...editorStore.getState().doc.assetRefs];
    },
    async opfsHasAsset(ref: string) {
      if (!isOpfsAvailable()) return false;
      const blob = await getAsset(ref);
      return blob !== null;
    },
    importKbnoteText(text: string) {
      try {
        const { doc, migrationNotes } = parseKBNote(text);
        editorStore.getState().loadDoc(doc);
        return { ok: true as const, version: doc.version, migrationNotes };
      } catch (e) {
        if (e instanceof KBNoteFileError) return { ok: false as const, errorKind: e.kind };
        return { ok: false as const, errorKind: 'schema' };
      }
    },
    currentLinks() {
      return [...editorStore.getState().doc.links];
    },
    exportCurrent() {
      return serializeKBNote(editorStore.getState().doc);
    },
    async backlinksTo(docId: string, nodeId: string | null = null) {
      return loadBacklinks(editorStore.getState().doc, docId, nodeId);
    },
    mountOverviewDev() {
      mountOverviewDev();
    },
    unmountOverviewDev() {
      unmountOverviewDev();
    },
  };
}
