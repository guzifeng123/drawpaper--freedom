import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEditorStore, CURRENT_DOC_VERSION } from '@drawpaper/core';
import type { KBNoteDoc, StorageAdapter } from '@drawpaper/core';

// ---- 模块级单例 mock（create-panels-api.ts 顶部 import 的外部依赖）----
// 非当前文档分支直接读写模块级 storageAdapter，不经 store 注入，故在此可控化。
const { pushToast, loadDoc, saveDoc, listDocs } = vi.hoisted(() => ({
  pushToast: vi.fn(),
  loadDoc: vi.fn(),
  saveDoc: vi.fn(),
  listDocs: vi.fn(),
}));

vi.mock('@/panels/lib/toast', () => ({ pushToast }));
vi.mock('@/store/editor-store', () => ({
  storageAdapter: { loadDoc, saveDoc, listDocs },
  hostAdapter: {},
}));
// db 仅 docDeleteImpact 路径触达；测试不走该路径，但 import 不能让 Dexie 在 jsdom 里实化。
vi.mock('@/storage/db', () => ({ db: { docs: { toArray: vi.fn().mockResolvedValue([]) } } }));

import { createPanelsApi } from './create-panels-api';

function blankDoc(id: string, title: string): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: CURRENT_DOC_VERSION,
    id,
    title,
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
    sync: { vv: {} },
  };
}

/** 让 async 回调里的 microtask 全部排空。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function setupApi() {
  // 当前文档 id = 'boot'，后续 rename/duplicate 传别的 id 即落非当前分支。
  const store = createEditorStore(blankDoc('boot', '当前文档'), {
    storage: { listDocs: vi.fn().mockResolvedValue([]) } as unknown as StorageAdapter,
  });
  return createPanelsApi(store);
}

describe('createPanelsApi：非当前文档 rename/duplicate 反馈 toast（Wave25 seam-polish）', () => {
  beforeEach(() => {
    pushToast.mockClear();
    loadDoc.mockReset();
    saveDoc.mockReset();
    listDocs.mockReset().mockResolvedValue([]);
  });

  it('renameDoc 非当前：成功 → saveDoc 落新标题 + success toast', async () => {
    loadDoc.mockResolvedValue(blankDoc('other', '旧标题'));
    saveDoc.mockResolvedValue(undefined);
    const api = setupApi();

    api.renameDoc('other', '新标题');
    await flush();

    expect(loadDoc).toHaveBeenCalledWith('other');
    expect(saveDoc).toHaveBeenCalledWith(expect.objectContaining({ id: 'other', title: '新标题' }));
    expect(pushToast).toHaveBeenCalledWith('success', '已重命名为「新标题」');
  });

  it('renameDoc 非当前：loadDoc 返回 null → error toast（找不到原文档）', async () => {
    loadDoc.mockResolvedValue(null);
    const api = setupApi();

    api.renameDoc('other', '新标题');
    await flush();

    expect(saveDoc).not.toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledWith('error', '重命名失败：找不到原文档');
  });

  it('renameDoc 非当前：saveDoc 抛错 → error toast 带原因', async () => {
    loadDoc.mockResolvedValue(blankDoc('other', '旧标题'));
    saveDoc.mockRejectedValue(new Error('disk full'));
    const api = setupApi();

    api.renameDoc('other', '新标题');
    await flush();

    expect(pushToast).toHaveBeenCalledWith('error', '重命名失败：disk full');
  });

  it('duplicateDoc 非当前：成功 → saveDoc 落「标题 副本」+ success toast', async () => {
    loadDoc.mockResolvedValue(blankDoc('src-id', '源标题'));
    saveDoc.mockResolvedValue(undefined);
    const api = setupApi();

    api.duplicateDoc('src-id');
    await flush();

    expect(saveDoc).toHaveBeenCalledWith(
      expect.objectContaining({ title: '源标题 副本', id: expect.stringMatching(/^doc_/) }),
    );
    expect(pushToast).toHaveBeenCalledWith('success', '已创建副本「源标题 副本」');
  });

  it('duplicateDoc 非当前：saveDoc 抛错 → error toast', async () => {
    loadDoc.mockResolvedValue(blankDoc('src-id', '源标题'));
    saveDoc.mockRejectedValue(new Error('quota exceeded'));
    const api = setupApi();

    api.duplicateDoc('src-id');
    await flush();

    expect(pushToast).toHaveBeenCalledWith('error', '创建副本失败：quota exceeded');
  });
});
