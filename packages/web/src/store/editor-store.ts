import { createEditorStore, CURRENT_DOC_VERSION } from '@drawpaper/core';
import type { KBNoteDoc } from '@drawpaper/core';
import { DexieStorageAdapter } from '../storage/db';
import { WebHostAdapter } from '../host/web-host';
import { buildIndex, searchDocs } from '../storage/search-index';
import { activeFileManager } from '../storage/fsa';
import { TEMPLATE_REGISTRY } from '../storage/templates';
import { createConflictBridge, type ConflictBridge } from '../wiring/conflict-bridge';

/**
 * React 单例 editor store：注入浏览器 storage / host，启动时打开最近文档或新建空白。
 * core 内部已自带 500ms 防抖自动保存；这里额外负责 MiniSearch 索引的 doc 变更同步。
 */

function blankInitialDoc(): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: CURRENT_DOC_VERSION,
    id: 'boot',
    title: '未命名画布',
    board: { createdAt: Date.now(), updatedAt: Date.now() },
    nodes: [],
    edges: [],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: {
      size: 'A4',
      orientation: 'portrait',
      marginMm: 15,
      mode: 'fit',
      showPageBreak: true,
      colorMode: 'color',
      header: false,
      footer: false,
      showPageNumbers: false,
      edgeLabels: true,
      pageBreaks: [],
    },
    assetRefs: [],
    links: [],
  };
}

export const storageAdapter = new DexieStorageAdapter();
export const hostAdapter = new WebHostAdapter();

/** 多父/成环冲突弹窗桥：store 挂起 → CanvasEditor 的 ConflictDialog 收集结果。 */
export const conflictBridge: ConflictBridge = createConflictBridge();

export const editorStore = createEditorStore(blankInitialDoc(), {
  storage: storageAdapter,
  host: hostAdapter,
  resolveConflictUi: (pending) => conflictBridge.handler(pending),
  templates: TEMPLATE_REGISTRY,
  fsa: activeFileManager,
});

/** 启动后：列出文档 → 打开最近一份；没有则新建。 */
async function bootstrap(): Promise<void> {
  await editorStore.getState().listDocs();
  const docs = editorStore.getState().docs;
  const recent = [...docs].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (recent) {
    await editorStore.getState().openDoc(recent.id);
  } else {
    editorStore.getState().newDoc();
  }
  // 尝试恢复上次活动本地文件句柄（需用户重新授权；失败则保持 IndexedDB 自动保存）。
  try {
    const name = await activeFileManager.restoreActiveFile();
    if (name) {
      editorStore.setState({ activeFile: { name } });
    }
  } catch {
    /* 无活动句柄或未授权 */
  }
  startSearchSync();
}

/** doc 变更防抖重建 MiniSearch；searchQuery 变化时即时查询。 */
function startSearchSync(): void {
  let index = buildIndex(editorStore.getState().doc);
  editorStore.getState().setSearchIndex(index);
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

  editorStore.subscribe((state, prev) => {
    if (state.searchQuery !== prev.searchQuery) {
      editorStore.getState().setSearchResults(searchDocs(index, state.searchQuery));
    }
    if (state.doc !== prev.doc) {
      if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        const pt = performance.now();
        index = buildIndex(state.doc);
        const dt = performance.now() - pt;
        const w = window as unknown as { __perfStages?: Record<string, number> };
        if (w.__perfStages) w.__perfStages.buildIndex = dt;
        editorStore.getState().setSearchIndex(index);
        const q = editorStore.getState().searchQuery;
        if (q) editorStore.getState().setSearchResults(searchDocs(index, q));
      }, 300);
    }
  });
}

void bootstrap();
