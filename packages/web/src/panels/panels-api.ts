import type {
  BlockNode,
  KBNoteDoc,
  LayoutMode,
  LayoutPrefs,
  PageSettings,
} from '@drawpaper/core';

/**
 * PanelsApi：工具栏 / 文档列表 / 搜索 / 导出面板与应用主状态之间的结构型接口。
 *
 * 设计约定（Wave1-E 接缝）：
 * - 面板组件不直接 import src/store（那是 Wave1-C 的范围），只通过 props 拿这个 api。
 * - api 同时承载「数据切片」与「回调」；Wave2 由 App 用 zustand store 把它们接起来。
 * - createMockPanelsApi() 提供一个自包含、可交互的内存实现，供开发、单测与截图使用。
 */

/** 文档列表项元信息。 */
export interface DocMeta {
  id: string;
  title: string;
  updatedAt: number;
}

/** 自动保存状态文案机。 */
export type SaveState = 'idle' | 'saving' | 'saved';

/** 单条全文搜索命中。 */
export interface SearchResultItem {
  nodeId: string;
  nodeType: BlockNode['type'];
  /** 命中片段（纯文本）。 */
  snippet: string;
  /** 命中词在 snippet 中的起止（用于 <mark> 高亮）。 */
  matchStart: number;
  matchLength: number;
  score: number;
}

export interface PanelsApi {
  // ---- 文档列表 / 当前文档 ----
  docs: DocMeta[];
  currentDocId: string | null;
  doc: KBNoteDoc | null;

  // ---- 保存状态 ----
  saveState: SaveState;
  savedAt: number | null;

  // ---- 选择 / 布局偏好 ----
  selectedNodeIds: string[];
  layoutPrefs: LayoutPrefs;
  /** 「仅整理选中分支」开关。 */
  branchOnly: boolean;
  canUndo: boolean;
  canRedo: boolean;

  // ---- 页面 / 导出 ----
  page: PageSettings;
  exportOpen: boolean;

  // ---- 搜索 ----
  searchOpen: boolean;
  searchQuery: string;
  searchResults: SearchResultItem[];
  /** 键盘 ↑↓ 选中的结果下标（-1 表示无）。 */
  activeSearchIndex: number;

  // ---- 文档回调 ----
  newDoc(): void;
  renameDoc(id: string, title: string): void;
  duplicateDoc(id: string): void;
  removeDoc(id: string): void;
  openDoc(id: string): void;
  importKbnote(file: File): void;
  exportKbnote(id: string): void;
  requestSave(): void;

  // ---- 编辑回调 ----
  undo(): void;
  redo(): void;

  // ---- 布局回调 ----
  setLayoutMode(mode: LayoutMode): void;
  /** 打开「整理预览」（半透明目标位置）；确认/应用由画布侧消费。 */
  previewLayout(): void;
  setRankSpacing(v: number): void;
  setNodeSpacing(v: number): void;
  setBranchOnly(v: boolean): void;

  // ---- 页面 / 导出回调 ----
  setPageSettings(patch: Partial<PageSettings>): void;
  setPageOrigin(origin: { x: number; y: number }): void;
  openExport(): void;
  closeExport(): void;

  // ---- 搜索回调 ----
  openSearch(): void;
  closeSearch(): void;
  setSearchQuery(q: string): void;
  selectSearchResult(index: number): void;
  flyToNode(id: string): void;
}
