import { describe, it, expect } from 'vitest';
import type { BlockNode, Edge } from '../model/index.js';
import {
  layoutTree,
  layoutTreeIncremental,
  DEFAULT_NODE_SIZE,
  type LayoutInput,
  type LayoutPosition,
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

  it('radial：深度越大半径越大、同层无残留重叠、确定性输出', () => {
    const r1 = layoutTree(baseInput(), 'radial');
    const r2 = layoutTree(baseInput(), 'radial');
    // 确定性：两次调用逐字节一致。
    expect(r1.positions).toEqual(r2.positions);
    // 全部节点都有位置。
    expect(Object.keys(r1.positions).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    // 无残留重叠（整圆分布 + 第一环放宽）。
    expect(r1.collisions.overlappingPairs).toHaveLength(0);

    // 深度→半径单调：以根 a 为圆心算各节点距离。
    const p = r1.positions;
    const cx = p['a']!.x + DEFAULT_NODE_SIZE.width / 2;
    const cy = p['a']!.y + DEFAULT_NODE_SIZE.height / 2;
    const dist = (id: string): number => {
      const dx = p[id]!.x + DEFAULT_NODE_SIZE.width / 2 - cx;
      const dy = p[id]!.y + DEFAULT_NODE_SIZE.height / 2 - cy;
      return Math.hypot(dx, dy);
    };
    // a=depth0 半径最小（=0）。
    expect(dist('a')).toBeCloseTo(0, 6);
    // depth1（b,c）< depth2（d,e,g）< depth3（f）。
    expect(dist('b')).toBeGreaterThan(dist('a'));
    expect(dist('d')).toBeGreaterThan(dist('b'));
    expect(dist('f')).toBeGreaterThan(dist('d'));
    // 同层半径近似相等。
    expect(dist('b')).toBeCloseTo(dist('c'), 1);
    expect(dist('d')).toBeCloseTo(dist('e'), 1);
    expect(dist('d')).toBeCloseTo(dist('g'), 1);
  });

  it('radial 与 right/down 切换：结果字段完整', () => {
    for (const mode of ['mindmap-right', 'mindmap-down', 'org-tree', 'radial'] as const) {
      const r = layoutTree(baseInput(), mode);
      expect(r.positions).toBeDefined();
      expect(r.collisions.overlappingPairs).toBeDefined();
      expect(r.collisions.detouredNodes).toBeDefined();
      expect(r.notes).toBeDefined();
      // 每个模式都返回全部 7 个节点位置。
      expect(Object.keys(r.positions)).toHaveLength(7);
    }
  });

  it('整体无负坐标（归一化）', () => {
    const r = layoutTree(baseInput(), 'mindmap-down');
    for (const p of Object.values(r.positions)) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('layout / radial 极坐标', () => {
  it('单根树深度越大半径越大（环形外扩）', () => {
    const r = layoutTree(baseInput(), 'radial');
    const p = r.positions;
    const cx = p['a']!.x + DEFAULT_NODE_SIZE.width / 2;
    const cy = p['a']!.y + DEFAULT_NODE_SIZE.height / 2;
    const dist = (id: string): number => {
      const dx = p[id]!.x + DEFAULT_NODE_SIZE.width / 2 - cx;
      const dy = p[id]!.y + DEFAULT_NODE_SIZE.height / 2 - cy;
      return Math.hypot(dx, dy);
    };
    expect(dist('f')).toBeGreaterThan(dist('d'));
    expect(dist('d')).toBeGreaterThan(dist('b'));
  });

  it('同层角度互不重叠（无残留 AABB 重叠）', () => {
    const r = layoutTree(baseInput(), 'radial');
    expect(r.collisions.overlappingPairs).toHaveLength(0);
  });

  it('确定性输出：两次调用 positions 逐字节一致', () => {
    const r1 = layoutTree(baseInput(), 'radial');
    const r2 = layoutTree(baseInput(), 'radial');
    expect(r1).toEqual(r2);
  });
});

describe('layout / manualFixed', () => {
  it('manualFixed 节点坐标不变且与 pinned 同避让、无残留重叠', () => {
    const nodes = [makeNode('a'), makeNode('b', { x: 0, y: 0 })];
    const edges = [makeEdge('e_ab', 'a', 'b')];
    const r = layoutTree(
      {
        nodes,
        edges,
        rankSpacing: 90,
        nodeSpacing: 28,
        measured: {},
        manualFixed: new Set(['b']),
      },
      'mindmap-right',
    );
    // manualFixed b 坐标严格不变。
    expect(r.positions['b']).toEqual({ x: 0, y: 0 });
    // a 被绕行。
    expect(r.collisions.detouredNodes).toContain('a');
    expect(r.collisions.overlappingPairs).toHaveLength(0);
    // notes 区分 manualFixed。
    expect(r.notes.some((n) => n.includes('manualFixed'))).toBe(true);
  });
});

describe('layout / tighten 折叠收紧', () => {
  it('折叠中间节点后收拢结果无重叠、被折叠后代无位置', () => {
    // 不收紧：折叠 b 后仍有节点位置。
    const loose = layoutTree(baseInput({ collapsed: { b: true } }), 'mindmap-down');
    expect(loose.positions['b']).toBeDefined();
    expect(loose.positions['d']).toBeUndefined();
    expect(loose.positions['f']).toBeUndefined();

    // 收紧：同样折叠，后代仍无位置、无残留重叠。
    const tight = layoutTree(baseInput({ collapsed: { b: true }, tighten: true }), 'mindmap-down');
    expect(tight.positions['b']).toBeDefined();
    expect(tight.positions['d']).toBeUndefined();
    expect(tight.positions['e']).toBeUndefined();
    expect(tight.positions['f']).toBeUndefined();
    expect(tight.collisions.overlappingPairs).toHaveLength(0);
    // notes 记录 tighten。
    expect(tight.notes.some((n) => n.includes('tighten'))).toBe(true);
  });

  it('tighten 包围盒比不收紧更紧凑（同夹具）', () => {
    const box = (r: { positions: Record<string, LayoutPosition> }): number => {
      let maxX = 0;
      let maxY = 0;
      for (const p of Object.values(r.positions)) {
        maxX = Math.max(maxX, p.x + DEFAULT_NODE_SIZE.width);
        maxY = Math.max(maxY, p.y + DEFAULT_NODE_SIZE.height);
      }
      return maxX * maxY;
    };
    // 不等宽节点：b 行里 d 宽 400、e 宽 100。不收紧用全局极值占位会更宽。
    const measured: Record<string, MeasuredSize> = {
      d: { width: 400, height: 80 },
      e: { width: 100, height: 80 },
    };
    const loose = layoutTree(baseInput({ measured }), 'mindmap-down');
    const tight = layoutTree(baseInput({ measured, tighten: true }), 'mindmap-down');
    expect(box(tight)).toBeLessThanOrEqual(box(loose));
  });
});

describe('layout / layoutTreeIncremental 增量整理', () => {
  it('缺省 changedRootIds = 全量重排（等价 layoutTree）', () => {
    const full = layoutTree(baseInput(), 'mindmap-down');
    const inc = layoutTreeIncremental({ positions: {} }, baseInput(), 'mindmap-down');
    expect(inc.positions).toEqual(full.positions);
  });

  it('加一条边/改一个叶子：未受影响分支坐标逐字节不变', () => {
    // 1) 全量布局得到 positions0。
    const positions0 = layoutTree(baseInput(), 'mindmap-down').positions;

    // 2) 在 b 下新增叶子 h，changedRootIds={b}。
    const { nodes, edges } = buildFixture();
    nodes.push(makeNode('h'));
    edges.push(makeEdge('e_bh', 'b', 'h'));
    const inc = layoutTreeIncremental(
      { positions: positions0 },
      {
        nodes,
        edges,
        rankSpacing: 90,
        nodeSpacing: 28,
        measured: {},
        changedRootIds: new Set(['b']),
      },
      'mindmap-down',
    );

    // 3) 未受影响分支（a, c, g）坐标逐字节等于 positions0。
    for (const id of ['a', 'c', 'g']) {
      expect(inc.positions[id]).toEqual(positions0[id]);
    }
    // 受影响子树（b, d, e, f）与新叶子 h 都有位置。
    for (const id of ['b', 'd', 'e', 'f', 'h']) {
      expect(inc.positions[id]).toBeDefined();
    }
    // notes 记录增量整理。
    expect(inc.notes.some((n) => n.includes('增量整理'))).toBe(true);
  });

  it('manualFixed 节点在增量整理中坐标不变且无重叠', () => {
    const positions0 = layoutTree(baseInput(), 'mindmap-down').positions;
    const { nodes, edges } = buildFixture();
    // 把 c 设为 manualFixed，钉在 positions0[c]。
    const cNode = nodes.find((n) => n.id === 'c')!;
    cNode.x = positions0['c']!.x;
    cNode.y = positions0['c']!.y;
    const inc = layoutTreeIncremental(
      { positions: positions0 },
      {
        nodes,
        edges,
        rankSpacing: 90,
        nodeSpacing: 28,
        measured: {},
        manualFixed: new Set(['c']),
        changedRootIds: new Set(['b']),
      },
      'mindmap-down',
    );
    expect(inc.positions['c']).toEqual(positions0['c']);
  });
});
