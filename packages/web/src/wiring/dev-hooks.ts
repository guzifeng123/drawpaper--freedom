import type { KBNoteDoc } from '@drawpaper/core';
import { editorStore } from '@/store/editor-store';

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
  getState(): { doc: KBNoteDoc; viewport: { x: number; y: number; zoom: number }; nodeCount: number };
  /** 按名调用白名单内的 store action。 */
  invoke(action: string, ...args: unknown[]): unknown;
  /** 常驻渲染离屏打印容器（e2e 截图/矢量 PDF 用）。 */
  setDebugSheets(on: boolean): void;
}

declare global {
  interface Window {
    __drawpaper__?: DrawpaperDevHook;
    /** App 在 DEV 下读取此标志，常驻打印容器供 e2e。 */
    __drawpaper_debugSheets?: boolean;
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
  'applyAISuggestions',
  'setLayoutMode',
]);

export function installDevHooks(): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === 'undefined') return;
  window.__drawpaper__ = {
    loadFixture(doc: KBNoteDoc) {
      editorStore.getState().loadDoc(doc);
    },
    getState() {
      const s = editorStore.getState();
      return {
        doc: s.doc,
        viewport: s.viewport,
        nodeCount: s.doc.nodes.length,
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
  };
}
