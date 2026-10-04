import type {
  BlockNode,
  Edge,
  KBNoteDoc,
  PageSettings,
} from '@drawpaper/core';
import type { PanelsApi, DocMeta, SearchResultItem } from './panels-api';

/** 构造一个最小合法的空文档（用于 mock）。 */
function makeSampleDoc(id: string, title: string): KBNoteDoc {
  const now = Date.now();
  const rootNode: BlockNode = {
    id: 'n_root',
    type: 'heading',
    x: 0,
    y: 0,
    width: 240,
    height: 60,
    content: { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }] } },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
    heading: { level: 1 },
  };
  const child: BlockNode = {
    id: 'n_child',
    type: 'text',
    x: 320,
    y: 0,
    width: 260,
    height: 100,
    content: {
      format: 'tiptap-json',
      data: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '示例子块：在这里记录你的想法。' }] },
        ],
      },
    },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
  };
  const edge: Edge = {
    id: 'e_1',
    source: 'n_root',
    target: 'n_child',
    sourceHandle: 'right',
    targetHandle: 'left',
    label: '',
    directed: true,
    style: { color: '#94A3B8' },
  };
  return {
    format: 'knowledge-block-notes',
    version: 1,
    id,
    title,
    board: { createdAt: now, updatedAt: now },
    nodes: [rootNode, child],
    edges: [edge],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: defaultPageSettings(),
    assetRefs: [],
  };
}

export function defaultPageSettings(): PageSettings {
  return {
    size: 'A4',
    orientation: 'portrait',
    marginMm: 15,
    mode: 'tiles',
    showPageBreak: false,
    colorMode: 'color',
    header: true,
    footer: true,
    showPageNumbers: true,
    edgeLabels: true,
    pageBreaks: [],
  };
}

/**
 * 自包含内存 mock：供开发 / 单测 / 截图使用。
 * 回调会真实改动内部状态（docs 列表、当前文档标题、保存状态等），
 * 但不做任何持久化，也不触发真实布局/分页（那些由 Wave1-B/C 接线）。
 */
export function createMockPanelsApi(): PanelsApi {
  const docs: DocMeta[] = [
    { id: 'doc_1', title: '未命名画布', updatedAt: Date.now() - 1000 * 60 * 12 },
    { id: 'doc_2', title: '读书笔记', updatedAt: Date.now() - 1000 * 60 * 60 * 5 },
  ];
  const docById = new Map<string, KBNoteDoc>([
    ['doc_1', makeSampleDoc('doc_1', '未命名画布')],
    ['doc_2', makeSampleDoc('doc_2', '读书笔记')],
  ]);

  const state = {
    currentDocId: 'doc_1' as string,
    saveState: 'saved' as PanelsApi['saveState'],
    savedAt: Date.now() - 1000 * 30,
    branchOnly: false,
    canUndo: false,
    canRedo: false,
    exportOpen: false,
    searchOpen: false,
    searchQuery: '',
    activeSearchIndex: -1,
  };

  const api: PanelsApi = {
    docs,
    get currentDocId() {
      return state.currentDocId;
    },
    get doc() {
      return docById.get(state.currentDocId) ?? null;
    },
    get saveState() {
      return state.saveState;
    },
    get savedAt() {
      return state.savedAt;
    },
    selectedNodeIds: [],
    layoutPrefs: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    get branchOnly() {
      return state.branchOnly;
    },
    get canUndo() {
      return state.canUndo;
    },
    get canRedo() {
      return state.canRedo;
    },
    get page() {
      return api.doc?.page ?? defaultPageSettings();
    },
    get exportOpen() {
      return state.exportOpen;
    },
    get searchOpen() {
      return state.searchOpen;
    },
    get searchQuery() {
      return state.searchQuery;
    },
    searchResults: [] as SearchResultItem[],
    get activeSearchIndex() {
      return state.activeSearchIndex;
    },

    newDoc() {
      const id = `doc_${Date.now()}`;
      const d = makeSampleDoc(id, '未命名画布');
      docs.push({ id, title: d.title, updatedAt: d.board.updatedAt });
      docById.set(id, d);
      state.currentDocId = id;
    },
    renameDoc(id, title) {
      const meta = docs.find((d) => d.id === id);
      if (meta) meta.title = title;
      const doc = docById.get(id);
      if (doc) doc.title = title;
    },
    duplicateDoc(id) {
      const src = docById.get(id);
      if (!src) return;
      const copy: KBNoteDoc = JSON.parse(JSON.stringify(src)) as KBNoteDoc;
      copy.id = `doc_${Date.now()}`;
      copy.title = `${src.title} 副本`;
      docById.set(copy.id, copy);
      docs.push({ id: copy.id, title: copy.title, updatedAt: Date.now() });
    },
    removeDoc(id) {
      const idx = docs.findIndex((d) => d.id === id);
      if (idx >= 0) docs.splice(idx, 1);
      docById.delete(id);
      if (state.currentDocId === id) state.currentDocId = docs[0]?.id ?? '';
    },
    openDoc(id) {
      state.currentDocId = id;
    },
    importKbnote(_file: File) {
      /* mock：真实导入由 Wave1-A serialize + Wave1-C storage 接线 */
    },
    exportKbnote(_id: string) {
      /* mock：真实导出由 host/storage 接线 */
    },
    requestSave() {
      state.saveState = 'saved';
      state.savedAt = Date.now();
    },
    undo() {
      state.canUndo = false;
    },
    redo() {
      state.canRedo = false;
    },
    setLayoutMode(mode) {
      api.layoutPrefs.mode = mode;
    },
    previewLayout() {
      /* mock：真实预览由画布侧消费 */
    },
    setRankSpacing(v) {
      api.layoutPrefs.rankSpacing = v;
    },
    setNodeSpacing(v) {
      api.layoutPrefs.nodeSpacing = v;
    },
    setBranchOnly(v) {
      state.branchOnly = v;
    },
    setPageSettings(patch) {
      const doc = docById.get(state.currentDocId);
      if (doc) doc.page = { ...doc.page, ...patch };
    },
    setPageOrigin(origin) {
      const doc = docById.get(state.currentDocId);
      if (doc) doc.page = { ...doc.page, pageOrigin: origin };
    },
    openExport() {
      state.exportOpen = true;
    },
    closeExport() {
      state.exportOpen = false;
    },
    openSearch() {
      state.searchOpen = true;
    },
    closeSearch() {
      state.searchOpen = false;
      state.searchQuery = '';
    },
    setSearchQuery(q) {
      state.searchQuery = q;
      state.activeSearchIndex = -1;
    },
    selectSearchResult(index) {
      state.activeSearchIndex = index;
      const item = api.searchResults[index];
      if (item) api.flyToNode(item.nodeId);
    },
    flyToNode(_id: string) {
      /* mock：真实飞行定位由画布侧消费 */
    },
  };

  return api;
}
