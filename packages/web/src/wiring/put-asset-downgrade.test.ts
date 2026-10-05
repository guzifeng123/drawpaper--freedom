import { describe, expect, it, vi } from 'vitest';
import { createEditorStore, serializeKBNote, parseKBNote, CURRENT_DOC_VERSION } from '@drawpaper/core';
import type { KBNoteDoc, StorageAdapter } from '@drawpaper/core';
import { createConflictBridge } from './conflict-bridge';
import { createEditorApi } from './create-editor-api';

/**
 * Wave7 robustness：附件 dataURL 降级分支集成测试。
 *
 * 模拟 OPFS 不可用（storage.putAsset 抛 OpfsUnavailableError，等价于
 * navigator.storage.getDirectory 缺失 / 非安全上下文），走真实
 * createEditorStore + createEditorApi 接线：
 *  - 上传附件后 assetRef 必须是 data: 内联（不能是丢空字符串）；
 *  - doc.assetRefs 形状一致（OPFS 不可用时不登记幽灵 ref）；
 *  - serialize → parse 往返后 dataURL 仍在（reload 后仍可打开）。
 *
 * 注意：本测试不改 opfs.ts 生产代码；不可用状态通过注入的 storage 适配器
 * 抛错模拟（与 DexieStorageAdapter 在 OPFS 缺失时抛 OpfsUnavailableError 同形）。
 */

function blankDoc(): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: CURRENT_DOC_VERSION,
    id: 'devtest',
    title: '降级测试',
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

/** 一个 putAsset 抛 OpfsUnavailableError 的 storage（模拟 OPFS 不可用）。 */
function makeUnavailableStorage(): StorageAdapter {
  return {
    saveDoc: vi.fn().mockResolvedValue(undefined),
    loadDoc: vi.fn().mockResolvedValue(null),
    listDocs: vi.fn().mockResolvedValue([]),
    deleteDoc: vi.fn().mockResolvedValue(undefined),
    getAsset: vi.fn().mockResolvedValue(null),
    putAsset: vi.fn().mockRejectedValue(new Error('OPFS is not available in this environment')),
    deleteAsset: vi.fn().mockResolvedValue(undefined),
  } as unknown as StorageAdapter;
}

/** putAsset 成功的 storage（OPFS happy path 对照）。 */
function makeOkStorage(): StorageAdapter {
  return {
    saveDoc: vi.fn().mockResolvedValue(undefined),
    loadDoc: vi.fn().mockResolvedValue(null),
    listDocs: vi.fn().mockResolvedValue([]),
    deleteDoc: vi.fn().mockResolvedValue(undefined),
    getAsset: vi.fn().mockResolvedValue(null),
    putAsset: vi.fn().mockResolvedValue({ assetRef: 'opfs_real_ref_123' }),
    deleteAsset: vi.fn().mockResolvedValue(undefined),
  } as unknown as StorageAdapter;
}

describe('附件 dataURL 降级（OPFS 不可用）', () => {
  it('OPFS 不可用：putImageAsset 返回 data: 内联，assetRefs 不登记幽灵 ref', async () => {
    const storage = makeUnavailableStorage();
    const store = createEditorStore(blankDoc(), { storage });
    const bridge = createConflictBridge();
    const api = createEditorApi(store, bridge);

    const file = new File(['hello-downgrade'], 'note.txt', { type: 'text/plain' });
    const r = await api.putImageAsset!(file);

    // dataURL 内联，不是空串也不是 OPFS ref。
    expect(r.assetRef.startsWith('data:')).toBe(true);
    expect(r.name).toBe('note.txt');
    expect(r.size).toBe(file.size);
    // 成功路径才会 register-asset；降级路径不应在 doc.assetRefs 留下幽灵 ref。
    expect(store.getState().doc.assetRefs).toEqual([]);
    expect(storage.putAsset).toHaveBeenCalledTimes(1);
  });

  it('OPFS 不可用：dataURL 经 serialize→parse 往返后仍在（reload 不丢）', async () => {
    const storage = makeUnavailableStorage();
    const store = createEditorStore(blankDoc(), { storage });
    const bridge = createConflictBridge();
    const api = createEditorApi(store, bridge);

    const file = new File(['roundtrip-bytes'], 'a.txt', { type: 'text/plain' });
    const r = await api.putImageAsset!(file);
    expect(r.assetRef.startsWith('data:')).toBe(true);

    // 把附件内容写进一个块的 content（模拟 AttachmentBlock.onPick 的 updateContent）。
    const blockId = store.getState().addNode('attachment', 0, 0);
    store.getState().updateContent(blockId, {
      kind: 'attachment',
      assetRef: r.assetRef,
      name: 'a.txt',
      size: file.size,
      mime: 'text/plain',
    });

    // serialize → parse 往返（等价于 reload：Dexie 持久化 KBNote JSON 后再加载）。
    const text = serializeKBNote(store.getState().doc);
    const reparsed = parseKBNote(text);
    const block = reparsed.doc.nodes.find((n) => n.id === blockId);
    const inline = (block?.content?.data as { assetRef?: string })?.assetRef ?? '';
    expect(inline.startsWith('data:')).toBe(true);
    // dataURL 解码回原始字节。
    const b64 = inline.split(',')[1]!;
    expect(atob(b64)).toBe('roundtrip-bytes');
  });

  it('对照：OPFS 可用时返回 OPFS ref 并登记 assetRefs（不回退 dataURL）', async () => {
    const storage = makeOkStorage();
    const store = createEditorStore(blankDoc(), { storage });
    const bridge = createConflictBridge();
    const api = createEditorApi(store, bridge);

    const file = new File(['happy'], 'b.txt', { type: 'text/plain' });
    const r = await api.putImageAsset!(file);

    expect(r.assetRef).toBe('opfs_real_ref_123');
    expect(r.assetRef.startsWith('data:')).toBe(false);
    // 成功路径：assetRefs 登记。
    expect(store.getState().doc.assetRefs).toContain('opfs_real_ref_123');
  });
});
