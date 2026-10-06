import { describe, it, expect } from 'vitest';
import type { BlockNode, Edge, KBNoteDoc } from '@drawpaper/core';
import { diffDocOps } from './doc-diff';

function node(partial: Partial<BlockNode> & { id: string }): BlockNode {
  return {
    type: 'text',
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    content: { format: 'tiptap-json', data: { type: 'doc' } },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
    ...partial,
  } as BlockNode;
}

function edge(partial: Partial<Edge> & { id: string; source: string; target: string }): Edge {
  return {
    sourceHandle: 'right',
    targetHandle: 'left',
    label: '',
    directed: true,
    style: { color: '#3b82f6' },
    ...partial,
  } as Edge;
}

function doc(nodes: BlockNode[], edges: Edge[], title = 't'): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: 9,
    id: 'doc1',
    title,
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
      edgeLabels: true,
      pageBreaks: [],
    },
    assetRefs: [],
    links: [],
  } as unknown as KBNoteDoc;
}

describe('diffDocOps 本地差量 → CollabOp', () => {
  it('无变化返回空', () => {
    const d = doc([node({ id: 'a' })], []);
    expect(diffDocOps(d, d)).toEqual([]);
  });

  it('新增节点 → add-node', () => {
    const prev = doc([], []);
    const next = doc([node({ id: 'a', x: 10 })], []);
    const ops = diffDocOps(prev, next);
    expect(ops).toEqual([{ kind: 'add-node', node: expect.objectContaining({ id: 'a', x: 10 }) }]);
  });

  it('删除多个节点 → 单条 delete-nodes（级联边由 core 墓碑处理）', () => {
    const prev = doc([node({ id: 'a' }), node({ id: 'b' })], []);
    const next = doc([node({ id: 'a' })], []);
    const ops = diffDocOps(prev, next);
    expect(ops).toEqual([{ kind: 'delete-nodes', nodeIds: ['b'] }]);
  });

  it('改坐标/内容 → update-node 补丁', () => {
    const prev = doc([node({ id: 'a', x: 0 })], []);
    const next = doc([node({ id: 'a', x: 100, content: { format: 'tiptap-json', data: { type: 'doc', hello: 1 } } })], []);
    const ops = diffDocOps(prev, next);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'update-node', nodeId: 'a', patch: { x: 100 } });
    expect((ops[0] as { patch: { content: unknown } }).patch.content).toEqual({
      format: 'tiptap-json',
      data: { type: 'doc', hello: 1 },
    });
  });

  it('reparent：同时产出 delete-edge + add-edge + update-node(parentId)（原子打包由广播顺序编排）', () => {
    const prev = doc(
      [node({ id: 'a' }), node({ id: 'p1' }), node({ id: 'p2' })],
      [edge({ id: 'e1', source: 'p1', target: 'a' })],
    );
    const next = doc(
      [node({ id: 'a', parentId: 'p2' }), node({ id: 'p1' }), node({ id: 'p2' })],
      [edge({ id: 'e2', source: 'p2', target: 'a' })],
    );
    const ops = diffDocOps(prev, next);
    const kinds = ops.map((o) => o.kind);
    expect(kinds).toContain('delete-edge');
    expect(kinds).toContain('add-edge');
    expect(kinds).toContain('update-node');
    const parentOp = ops.find((o) => o.kind === 'update-node') as { patch: { parentId: string | null } };
    expect(parentOp.patch.parentId).toBe('p2');
  });

  it('边改 label/color → update-edge；points 走寄存器并集 reg-add', () => {
    const prev = doc([], [edge({ id: 'e1', source: 'a', target: 'b' })]);
    const next = doc([], [edge({ id: 'e1', source: 'a', target: 'b', label: '父子', style: { color: '#ef4444' }, points: [{ x: 1, y: 2 }] })]);
    const ops = diffDocOps(prev, next);
    const update = ops.find((o) => o.kind === 'update-edge');
    expect(update).toMatchObject({
      kind: 'update-edge',
      edgeId: 'e1',
      patch: { label: '父子', color: '#ef4444' },
    });
    const regAdd = ops.find((o) => o.kind === 'reg-add' && o.field === 'points');
    expect(regAdd).toMatchObject({ kind: 'reg-add', entity: 'edge', entityId: 'e1', field: 'points', items: [{ x: 1, y: 2 }] });
  });

  it('改标题 → set-doc-meta；改页面方向 → set-page', () => {
    const prev = doc([], [], '旧标题');
    const next = doc([], [], '新标题');
    (next.page as { orientation: string }).orientation = 'landscape';
    const ops = diffDocOps(prev, next);
    const meta = ops.find((o) => o.kind === 'set-doc-meta');
    const page = ops.find((o) => o.kind === 'set-page');
    expect(meta).toMatchObject({ patch: { title: '新标题' } });
    expect(page).toMatchObject({ patch: { orientation: 'landscape' } });
  });
});
