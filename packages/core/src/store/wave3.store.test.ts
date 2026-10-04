import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nanoid } from 'nanoid';
import { createEditorStore, pruneSnapshotsToLatest } from './store.js';
import type { EditorStoreApi } from './store.js';
import type { BlockNode, Edge, KBNoteDoc } from '../model/index.js';
import type { SnapshotRecord, StorageAdapter } from './adapters.js';

let store: EditorStoreApi;

function mkNode(id: string, x = 0, y = 0): BlockNode {
  return {
    id,
    type: 'text',
    x,
    y,
    width: 220,
    height: 80,
    content: { format: 'tiptap-json', data: { type: 'doc', content: [] } },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
  };
}

function mkEdge(id: string, source: string, target: string): Edge {
  return {
    id,
    source,
    target,
    sourceHandle: 'right',
    targetHandle: 'left',
    label: '',
    directed: true,
    style: { color: '#94A3B8' },
  };
}

function baseDoc(nodes: BlockNode[], edges: Edge[]): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: 1,
    id: 'doc1',
    title: 't',
    board: { createdAt: 0, updatedAt: 0 },
    nodes,
    edges,
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
      pageBreaks: [],
    },
    assetRefs: [],
  };
}

function noopAnalyzer() {
  return () => ({ multiParents: [] as never[], cycles: [] as never[] });
}

/** 内存 StorageAdapter：带快照表 + 20 条淘汰策略（与 web Dexie 一致）。 */
class MemSnapshotStorage implements StorageAdapter {
  snapshots: SnapshotRecord[] = [];
  async saveDoc() {}
  async loadDoc() { return null; }
  async listDocs() { return []; }
  async deleteDoc() {}
  async getAsset() { return null; }
  async putAsset() { return { assetRef: 'a' }; }
  async deleteAsset() {}
  async saveSnapshot(docId: string, label: string | null, text: string) {
    const rec: SnapshotRecord = {
      id: 's_' + nanoid(),
      docId,
      takenAt: Date.now() + this.snapshots.length,
      label,
      text,
    };
    this.snapshots.push(rec);
    this.snapshots = pruneSnapshotsToLatest(this.snapshots, 20);
    return rec;
  }
  async listSnapshots(docId: string) {
    return this.snapshots.filter((s) => s.docId === docId).map(({ text: _t, ...meta }) => meta);
  }
  async getSnapshot(id: string) {
    return this.snapshots.find((s) => s.id === id) ?? null;
  }
}

describe('快照：淘汰策略与恢复', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  it('保留最近 20 条（拍 21 条后只剩 20）', async () => {
    const storage = new MemSnapshotStorage();
    store = createEditorStore(baseDoc([mkNode('a')], []), { analyzer: noopAnalyzer(), storage });
    // switchDoc 已自动拍 1 条基线快照
    for (let i = 0; i < 20; i++) {
      await store.getState().snapshotDoc('m' + i);
    }
    const list = await store.getState().listSnapshots('doc1');
    expect(list.length).toBe(20);
  });
  it('restoreSnapshot 回到快照状态，且 undo 可再恢复', async () => {
    const storage = new MemSnapshotStorage();
    store = createEditorStore(baseDoc([mkNode('a')], []), { analyzer: noopAnalyzer(), storage });
    // 拍一条含 2 个块的快照
    store.getState().addNode('text', 1, 1);
    await store.getState().snapshotDoc('two-blocks');
    expect(store.getState().doc.nodes).toHaveLength(2);
    // 再加一个块
    store.getState().addNode('text', 2, 2);
    expect(store.getState().doc.nodes).toHaveLength(3);
    const snaps = await store.getState().listSnapshots('doc1');
    await store.getState().restoreSnapshot(snaps[snaps.length - 1]!.id);
    expect(store.getState().doc.nodes).toHaveLength(2);
    // undo 恢复到 3 块（恢复本身可撤销）
    store.getState().undo();
    expect(store.getState().doc.nodes).toHaveLength(3);
  });
});

describe('标签 CRUD', () => {
  it('create/delete 级联移除节点标签且可撤销', () => {
    store = createEditorStore(baseDoc([mkNode('a')], []), { analyzer: noopAnalyzer() });
    const id = store.getState().createTag('灵感', '#7c3aed');
    expect(store.getState().doc.tags.map((t) => t.id)).toContain(id);
    store.getState().addTagToNode('a', id);
    expect(store.getState().doc.nodes[0]!.tags).toContain(id);
    store.getState().deleteTag(id);
    expect(store.getState().doc.tags).toHaveLength(0);
    expect(store.getState().doc.nodes[0]!.tags).not.toContain(id);
    // undo 恢复标签与节点引用
    store.getState().undo();
    expect(store.getState().doc.tags.map((t) => t.id)).toContain(id);
    expect(store.getState().doc.nodes[0]!.tags).toContain(id);
  });
  it('renameTag / setTagColor 更新字段', () => {
    store = createEditorStore(baseDoc([mkNode('a')], []), { analyzer: noopAnalyzer() });
    const id = store.getState().createTag('旧名', '#000');
    store.getState().renameTag(id, '新名');
    store.getState().setTagColor(id, '#fff');
    const tag = store.getState().doc.tags.find((t) => t.id === id)!;
    expect(tag.name).toBe('新名');
    expect(tag.color).toBe('#fff');
  });
});

describe('结构调整：reparent / reverseEdge', () => {
  it('reparentNode 改父子边并同步 parentId 冗余', () => {
    store = createEditorStore(
      baseDoc([mkNode('a'), mkNode('b'), mkNode('c')], [mkEdge('e1', 'a', 'c')]),
      { analyzer: noopAnalyzer() },
    );
    store.getState().reparentNode('c', 'b');
    expect(store.getState().doc.edges.map((e) => [e.source, e.target])).toEqual([['b', 'c']]);
    expect(store.getState().doc.nodes.find((n) => n.id === 'c')!.parentId).toBe('b');
    // undo 回到 a→c
    store.getState().undo();
    expect(store.getState().doc.edges.map((e) => [e.source, e.target])).toEqual([['a', 'c']]);
    expect(store.getState().doc.nodes.find((n) => n.id === 'c')!.parentId).toBeNull();
  });
  it('reparentNode 拒绝挂到自身后代下（成环防护）', () => {
    store = createEditorStore(
      baseDoc([mkNode('a'), mkNode('b'), mkNode('c')], [mkEdge('e1', 'a', 'b'), mkEdge('e2', 'b', 'c')]),
      { analyzer: noopAnalyzer() },
    );
    // a 是 c 的祖先，把 c 挂到 a 的子树里 a 自身 → 拒绝
    store.getState().reparentNode('a', 'c');
    expect(store.getState().doc.edges).toHaveLength(2);
  });
  it('reverseEdge 交换 source/target 与句柄', () => {
    store = createEditorStore(baseDoc([mkNode('a'), mkNode('b')], [mkEdge('e1', 'a', 'b')]), {
      analyzer: noopAnalyzer(),
    });
    store.getState().reverseEdge('e1');
    const e = store.getState().doc.edges[0]!;
    expect([e.source, e.target]).toEqual(['b', 'a']);
    store.getState().undo();
    expect([store.getState().doc.edges[0]!.source, store.getState().doc.edges[0]!.target]).toEqual(['a', 'b']);
  });
});

describe('手动分页符', () => {
  it('add/remove 写入 doc.page.pageBreaks', () => {
    store = createEditorStore(baseDoc([mkNode('a')], []), { analyzer: noopAnalyzer() });
    store.getState().addManualPageBreak('p1', 0, 120);
    expect((store.getState().doc.page.pageBreaks as unknown as Array<{ id: string }>).map((b) => b.id)).toContain('p1');
    store.getState().removePageBreak('p1');
    expect(store.getState().doc.page.pageBreaks).toHaveLength(0);
  });
});

describe('applyAISuggestions（一条宏命令）', () => {
  it('只应用勾选建议，未勾选丢弃；五类变换各生效', () => {
    store = createEditorStore(baseDoc([mkNode('a'), mkNode('b')], [mkEdge('e0', 'a', 'b')]), {
      analyzer: noopAnalyzer(),
    });
    const suggestions = [
      // 0: add-edge（a→b 已存在 → 幂等跳过）
      { type: 'add-edge' as const, proposedEdges: [{ source: 'a', target: 'b' }], reason: '' },
      // 1: summarize
      { type: 'summarize' as const, nodeIds: ['a'], text: '这是摘要', reason: '' },
      // 2: split-block
      { type: 'split-block' as const, afterNodeId: 'a', text: '拆出的段落', reason: '' },
      // 3: group（b 入组）
      { type: 'group' as const, nodeIds: ['b'], title: '重点', reason: '' },
      // 4: add-edge（非法端点 → 跳过）
      { type: 'add-edge' as const, proposedEdges: [{ source: 'a', target: 'ghost' }], reason: '' },
    ];
    const before = store.getState().doc.nodes.length;
    store.getState().applyAISuggestions(suggestions, new Set([1, 2, 3]));
    // summarize：a 内容被替换
    const nodeA = store.getState().doc.nodes.find((n) => n.id === 'a')!;
    expect(JSON.stringify(nodeA.content.data)).toContain('这是摘要');
    // split-block：新增 1 个块
    expect(store.getState().doc.nodes.length).toBe(before + 2); // group + split
    // group：新建 group 块且 b.parentId 指向它
    const group = store.getState().doc.nodes.find((n) => n.type === 'group');
    expect(group).toBeDefined();
    expect(store.getState().doc.nodes.find((n) => n.id === 'b')!.parentId).toBe(group!.id);
    // 未勾选的 0/4 未生效：边数仍为 1（e0），无 ghost 边
    expect(store.getState().doc.edges).toHaveLength(2); // e0 + group->b
    // 整体一次 undo 全回退
    store.getState().undo();
    expect(store.getState().doc.nodes.length).toBe(2);
    expect(store.getState().doc.edges).toHaveLength(1);
  });
});

describe('manuallyMoved 与布局传参', () => {
  it('moveNode 记入 manualFixed 并在 previewLayout 传入', () => {
    const captured: unknown[] = [];
    store = createEditorStore(baseDoc([mkNode('a')], []), {
      analyzer: noopAnalyzer(),
      layoutEngine: (input) => {
        captured.push(input);
        return { positions: { a: { x: 1, y: 1 } } };
      },
    });
    store.getState().moveNode('a', 50, 60);
    expect(store.getState().manuallyMoved.has('a')).toBe(true);
    store.getState().previewLayout();
    const last = captured[captured.length - 1] as { manualFixed?: Set<string> };
    expect(last.manualFixed?.has('a')).toBe(true);
    // confirm 后清空
    store.getState().confirmLayout();
    expect(store.getState().manuallyMoved.size).toBe(0);
  });
});
