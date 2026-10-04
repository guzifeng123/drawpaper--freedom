import type { EditorStoreApi, KBNoteDoc } from '@drawpaper/core';
import { parseKBNote } from '@drawpaper/core';
import type { PanelsApi, SearchResultItem, DocMeta } from '@/panels/panels-api';
import { pushToast } from '@/panels/lib/toast';
import { useWiringUi } from './ui-store';
import { storageAdapter, hostAdapter } from '@/store/editor-store';

/**
 * createPanelsApi —— 把真实 EditorStore + wiring ui store + storage/host 适配为 E 的 PanelsApi。
 *
 * PanelsApi 是「读时取最新」的 getter 对象：面板组件在渲染期读 api.xxx；
 * App 通过 useEditorStore 订阅驱动自身重渲染，从而让面板读到最新值。
 * 回调直接转调 store action / storage / host / ui store。
 */
export function createPanelsApi(store: EditorStoreApi): PanelsApi {
  const nodeTypeOf = (nodeId: string) =>
    store.getState().doc.nodes.find((n) => n.id === nodeId)?.type ?? 'text';

  const api: PanelsApi = {
    // ---- 读切片（getter，每次渲染取最新）----
    get docs(): DocMeta[] {
      return store.getState().docs;
    },
    get currentDocId(): string | null {
      return store.getState().currentDocId;
    },
    get doc(): KBNoteDoc | null {
      return store.getState().doc;
    },
    get saveState() {
      return store.getState().saveState;
    },
    get savedAt() {
      return store.getState().savedAt;
    },
    get selectedNodeIds(): string[] {
      return [...store.getState().selection];
    },
    get layoutPrefs() {
      return store.getState().doc.layout;
    },
    get branchOnly() {
      return store.getState().layoutUi.scopeSelected;
    },
    get canUndo() {
      return store.getState().canUndo;
    },
    get canRedo() {
      return store.getState().canRedo;
    },
    get page() {
      return store.getState().doc.page;
    },
    get exportOpen() {
      return useWiringUi.getState().exportOpen;
    },
    get searchOpen() {
      return useWiringUi.getState().searchOpen;
    },
    get searchQuery() {
      return store.getState().searchQuery;
    },
    get searchResults(): SearchResultItem[] {
      const q = store.getState().searchQuery.trim();
      return store.getState().searchResults.map((r) => {
        const lower = r.snippet.toLowerCase();
        const idx = q ? lower.indexOf(q.toLowerCase()) : -1;
        return {
          nodeId: r.nodeId,
          nodeType: nodeTypeOf(r.nodeId),
          snippet: r.snippet,
          matchStart: idx < 0 ? 0 : idx,
          matchLength: idx < 0 ? 0 : q.length,
          score: 1,
        };
      });
    },
    get activeSearchIndex() {
      return useWiringUi.getState().activeSearchIndex;
    },

    // ---- 文档回调 ----
    newDoc: () => store.getState().newDoc(),
    renameDoc: (id, title) => {
      if (id === store.getState().currentDocId) {
        store.getState().renameDoc(title);
      } else {
        // 重命名非当前打开的文档：直接改 storage 记录。
        void (async () => {
          const d = await storageAdapter.loadDoc(id);
          if (d) {
            await storageAdapter.saveDoc({ ...d, title });
            await store.getState().listDocs();
          }
        })();
      }
    },
    duplicateDoc: (id) => {
      if (id === store.getState().currentDocId) {
        void store.getState().duplicateDoc();
      } else {
        void (async () => {
          const src = await storageAdapter.loadDoc(id);
          if (!src) return;
          const copy: KBNoteDoc = JSON.parse(JSON.stringify(src)) as KBNoteDoc;
          copy.id = `doc_${Date.now()}`;
          copy.title = `${src.title} 副本`;
          copy.board = { createdAt: Date.now(), updatedAt: Date.now() };
          await storageAdapter.saveDoc(copy);
          await store.getState().listDocs();
        })();
      }
    },
    removeDoc: (id) => void store.getState().deleteDoc(id),
    openDoc: (id) => void store.getState().openDoc(id),
    importKbnote: (file: File) => {
      void (async () => {
        try {
          const text = await file.text();
          const { doc } = parseKBNote(text);
          store.getState().loadDoc(doc);
          pushToast('success', `已导入「${doc.title}」`);
        } catch (err) {
          pushToast('error', `导入失败：${err instanceof Error ? err.message : '文件格式错误'}`);
        }
      })();
    },
    exportKbnote: (_id) => {
      const s = store.getState();
      s.requestSave();
      const text = s.exportKBNoteText();
      void hostAdapter.showSaveFilePicker(`${s.doc.title || '未命名画布'}.kbnote`, text);
    },
    requestSave: () => store.getState().requestSave(),

    // ---- 编辑回调 ----
    undo: () => store.getState().undo(),
    redo: () => store.getState().redo(),

    // ---- 布局回调 ----
    setLayoutMode: (mode) => store.getState().setLayoutMode(mode),
    previewLayout: () => store.getState().previewLayout(),
    setRankSpacing: (v) => store.getState().setSpacing(v, store.getState().doc.layout.nodeSpacing),
    setNodeSpacing: (v) => store.getState().setSpacing(store.getState().doc.layout.rankSpacing, v),
    setBranchOnly: (v) => {
      if (store.getState().layoutUi.scopeSelected !== v) store.getState().toggleScopeSelected();
    },

    // ---- 页面 / 导出回调 ----
    setPageSettings: (patch) => store.getState().setPageSettings(patch),
    setPageOrigin: (origin) => store.getState().setPageOrigin(origin),
    openExport: () => useWiringUi.getState().setExportOpen(true),
    closeExport: () => useWiringUi.getState().setExportOpen(false),

    // ---- 搜索回调 ----
    openSearch: () => useWiringUi.getState().setSearchOpen(true),
    closeSearch: () => {
      useWiringUi.getState().setSearchOpen(false);
      useWiringUi.getState().setActiveSearchIndex(-1);
      store.getState().setSearchQuery('');
    },
    setSearchQuery: (q) => {
      store.getState().setSearchQuery(q);
      useWiringUi.getState().setActiveSearchIndex(-1);
    },
    selectSearchResult: (index) => {
      useWiringUi.getState().setActiveSearchIndex(index);
      const item = store.getState().searchResults[index];
      if (item) store.getState().flyToNode(item.nodeId);
    },
    flyToNode: (id) => store.getState().flyToNode(id),

    // ============================================================
    // Wave3-H 桩：本分支为满足 PanelsApi 接口自洽的最小编译实现。
    // 真实 store 动作（reparentNode / 标签 CRUD / 快照 / 回收站 / 模板 /
    // 活动文件句柄 / setFocusNode / 筛选下发）由存储 agent 同期在 store 实现，
    // Wave4 总装时在此替换为真实接线；此处只做能从现有状态读到的部分。
    // ============================================================
    get tags() {
      return store.getState().doc.tags;
    },
    get tagFilter() {
      return { tagIds: [], blockTypes: [], colors: [], match: 'any' as const };
    },
    get focusNodeId() {
      return null;
    },
    get activeFile() {
      return { name: null };
    },
    get snapshots() {
      return [] as import('@/panels/panels-api').SnapshotInfo[];
    },
    get trash() {
      return [] as import('@/panels/panels-api').TrashItem[];
    },
    createTag: () => undefined,
    renameTag: () => undefined,
    changeTagColor: () => undefined,
    deleteTag: () => undefined,
    setTagFilter: () => undefined,
    clearTagFilter: () => undefined,
    toggleCollapseNode: (id) => store.getState().toggleCollapse(id),
    reparentNode: () => undefined,
    addChildBlock: () => '',
    addSiblingBlock: () => '',
    setFocusNode: () => undefined,
    openLocalFile: () => undefined,
    saveAsLocalFile: () => undefined,
    createDocFromTemplate: () => undefined,
    takeSnapshot: () => undefined,
    restoreSnapshot: () => undefined,
    deleteSnapshot: () => undefined,
    restoreFromTrash: () => undefined,
    purgeFromTrash: () => undefined,
    emptyTrash: () => undefined,
  };

  return api;
}
