import { describe, it, expect } from 'vitest';
import type { BlockNode, Edge } from '../model/index.js';
import {
  layoutTree,
  DEFAULT_NODE_SIZE,
  type LayoutInput,
  type MeasuredSize,
} from './layout.js';

/** 构造一个最小 BlockNode（测试用）。 */
function makeNode(id: string, extra?: Partial<BlockNode>): BlockNode {
  return {
    id,
    type: 'text',
    x: 0,
    y: 0,
    width: 260,
    height: 80,
    content: { format: 'tiptap-json', data: { type: 'doc' } },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
    ...extra,
  };
}

function makeEdge(id: string, source: string, target: string): Edge {
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

/**
 * 手造树（≥3 层、每层多兄弟）：
 *        a
 *      /   \
 *     b     c
 *    / \     \
 *   d   e     g
 *   |
 *   f
 */
function buildFixture(): { nodes: BlockNode[]; edges: Edge[] } {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => makeNode(id));
  const edges = [
    makeEdge('e_ab', 'a', 'b'),
    makeEdge('e_ac', 'a', 'c'),
    makeEdge('e_bd', 'b', 'd'),
    makeEdge('e_be', 'b', 'e'),
    makeEdge('e_cg', 'c', 'g'),
    makeEdge('e_df', 'd', 'f'),
  ];
  return { nodes, edges };
}

function baseInput(over: Partial<LayoutInput> = {}): LayoutInput {
  const { nodes, edges } = buildFixture();
  return {
    nodes,
    edges,
    rankSpacing: 90,
    nodeSpacing: 28,
    measured: {},
    ...over,
  };
}

describe('layout / d3-hierarchy 三树', () => {
  it('mindmap-right：深度越大 x 越大，同层兄弟 y 互不重叠', () => {
    const r = layoutTree(baseInput(), 'mindmap-right');
    const p = r.positions;
    // 根 a 深度最小 → x 应最小。
    const xOf = (id: string) => p[id]!.x;
    expect(xOf('a')).toBeLessThan(xOf('b'));
    expect(xOf('a')).toBeLessThan(xOf('c'));
    expect(xOf('b')).toBeLessThan(xOf('d'));
    expect(xOf('b')).toBeLessThan(xOf('e'));
    expect(xOf('d')).toBeLessThan(xOf('f'));

    // 同层兄弟 b/c 顶边不重叠。
    const gap = Math.abs(p['b']!.y - p['c']!.y);
    expect(gap).toBeGreaterThanOrEqual(DEFAULT_NODE_SIZE.height);
    // d/e 同层。
    const gap2 = Math.abs(p['d']!.y - p['e']!.y);
    expect(gap2).toBeGreaterThanOrEqual(DEFAULT_NODE_SIZE.height);
  });

  it('mindmap-down：y 随深度增大', () => {
    const r = layoutTree(baseInput(), 'mindmap-down');
    const p = r.positions;
    expect(p['a']!.y).toBeLessThan(p['b']!.y);
    expect(p['a']!.y).toBeLessThan(p['c']!.y);
    expect(p['b']!.y).toBeLessThan(p['d']!.y);
    expect(p['b']!.y).toBeLessThan(p['e']!.y);
    expect(p['d']!.y).toBeLessThan(p['f']!.y);
  });

  it('org-tree：固定行高，同层顶对齐', () => {
    // 让 b 行里 d 高 200、e 高 60，验证行高取 max=200 且顶对齐。
    const measured: Record<string, MeasuredSize> = {
      d: { width: 200, height: 200 },
      e: { width: 200, height: 60 },
    };
    const r = layoutTree(baseInput({ measured }), 'org-tree');
    const p = r.positions;
    // d 与 e 同层 → 顶边 y 相等（顶对齐）。
    expect(p['d']!.y).toBe(p['e']!.y);
    // c 行在 b 行之下（深度递增）。
    expect(p['c']!.y).toBeGreaterThan(p['a']!.y);
    // b 行（深度1）在 d/e 行（深度2）之上。
    expect(p['b']!.y).toBeLessThan(p['d']!.y);
  });

  it('实测缺失走 DEFAULT_NODE_SIZE', () => {
    const r = layoutTree(baseInput({ measured: {} }), 'mindmap-down');
    // 不抛错且所有节点都有位置。
    expect(Object.keys(r.positions)).toHaveLength(7);
  });

  it('collapsed：折叠节点的后代无位置', () => {
    const r = layoutTree(
      baseInput({ collapsed: { b: true } }),
      'mindmap-down',
    );
    expect(r.positions['b']).toBeDefined();
    expect(r.positions['d']).toBeUndefined();
    expect(r.positions['e']).toBeUndefined();
    expect(r.positions['f']).toBeUndefined();
    // 其他分支不受影响。
    expect(r.positions['c']).toBeDefined();
    expect(r.positions['g']).toBeDefined();
  });

  it('pinned：坐标不变、detouredNodes 非空、无残留重叠', () => {
    // 2 节点树 a→b；把 b 钉在 (0,0)。非 pinned 的 a 经归一化后也落到 0 附近，
    // 必然与 pinned b 重叠 → 触发绕行。
    const nodes = [makeNode('a'), makeNode('b', { x: 0, y: 0 })];
    const edges = [makeEdge('e_ab', 'a', 'b')];
    const r = layoutTree(
      {
        nodes,
        edges,
        rankSpacing: 90,
        nodeSpacing: 28,
        measured: {},
        pinned: new Set(['b']),
      },
      'mindmap-right',
    );
    // pinned b 坐标严格不变。
    expect(r.positions['b']).toEqual({ x: 0, y: 0 });
    // a 被绕行。
    expect(r.collisions.detouredNodes).toContain('a');
    // 无残留重叠。
    expect(r.collisions.overlappingPairs).toHaveLength(0);
  });

  it('仅选中分支：只返回子集位置', () => {
    const { edges } = buildFixture();
    const subset = [makeNode('a'), makeNode('b')];
    const r = layoutTree(
      {
        nodes: subset,
        edges,
        rankSpacing: 90,
        nodeSpacing: 28,
        measured: {},
      },
      'mindmap-down',
    );
    expect(Object.keys(r.positions).sort()).toEqual(['a', 'b']);
  });

  it('radial 调用即抛错', () => {
    expect(() => layoutTree(baseInput(), 'radial')).toThrow();
  });

  it('整体无负坐标（归一化）', () => {
    const r = layoutTree(baseInput(), 'mindmap-down');
    for (const p of Object.values(r.positions)) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
  });
});
