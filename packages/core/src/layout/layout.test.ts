import { describe, it, expect } from 'vitest';
import type { BlockNode, Edge } from '../model/index.js';
import {
  layoutTree,
  layoutTreeIncremental,
  countLayerCrossings,
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

describe('layout / flow-layered 逻辑流分层（Wave21）', () => {
  // fixture：a→b,c；b→d,e；d→f；c→g（rank：a=0，b/c=1，d/e/g=2，f=3）。

  it('单树分层：rank 单调、同层 y 顶对齐、子不早于父', () => {
    const r = layoutTree(baseInput(), 'flow-layered');
    const p = r.positions;
    // 同层顶对齐：b/c 同层、d/e/g 同层。
    expect(p['b']!.y).toBe(p['c']!.y);
    expect(p['d']!.y).toBe(p['e']!.y);
    expect(p['d']!.y).toBe(p['g']!.y);
    // rank 单调递增。
    expect(p['a']!.y).toBeLessThan(p['b']!.y);
    expect(p['b']!.y).toBeLessThan(p['d']!.y);
    expect(p['d']!.y).toBeLessThan(p['f']!.y);
    // 子不早于父（每条主树边）。
    const edges: Array<[string, string]> = [
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'd'],
      ['b', 'e'],
      ['d', 'f'],
      ['c', 'g'],
    ];
    for (const [pa, ch] of edges) {
      expect(p[ch]!.y).toBeGreaterThan(p[pa]!.y);
    }
    // 无残留重叠。
    expect(r.collisions.overlappingPairs).toHaveLength(0);
  });

  it('单链 DAG：a→b→c→d→e 逐层加深、无重叠', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const nodes = ids.map(makeNode);
    const edges = ids
      .slice(1)
      .map((t, i) => makeEdge(`e_${ids[i]}_${t}`, ids[i]!, t));
    const r = layoutTree(
      { nodes, edges, rankSpacing: 90, nodeSpacing: 28, measured: {} },
      'flow-layered',
    );
    for (let i = 1; i < ids.length; i++) {
      expect(r.positions[ids[i]!]!.y).toBeGreaterThan(r.positions[ids[i - 1]!]!.y);
    }
    expect(r.collisions.overlappingPairs).toHaveLength(0);
  });

  it('多根森林：各根 rank=0 同行、根间不重叠、后代独立分层', () => {
    const nodes = ['r1', 'r2', 'a1', 'b1', 'c1'].map(makeNode);
    const edges = [
      makeEdge('e1', 'r1', 'a1'),
      makeEdge('e2', 'r2', 'b1'),
      makeEdge('e3', 'b1', 'c1'),
    ];
    const r = layoutTree(
      { nodes, edges, rankSpacing: 90, nodeSpacing: 28, measured: {} },
      'flow-layered',
    );
    const p = r.positions;
    // 两根同 rank0 → y 相等。
    expect(p['r1']!.y).toBe(p['r2']!.y);
    // 两根 x 不重叠（根间留同级间距）。
    expect(Math.abs(p['r1']!.x - p['r2']!.x)).toBeGreaterThanOrEqual(DEFAULT_NODE_SIZE.width);
    // 后代：a1/b1 同 rank1，c1 在 rank2。
    expect(p['a1']!.y).toBe(p['b1']!.y);
    expect(p['c1']!.y).toBeGreaterThan(p['b1']!.y);
    // 无残留重叠、notes 说明多根。
    expect(r.collisions.overlappingPairs).toHaveLength(0);
    expect(r.notes.some((n) => n.includes('多根森林'))).toBe(true);
  });

  it('同层不重叠：交错实测宽下仍零残留碰撞、输出确定', () => {
    const measured: Record<string, MeasuredSize> = {
      a: { width: 400, height: 60 },
      b: { width: 120, height: 100 },
      c: { width: 300, height: 70 },
    };
    const r = layoutTree(baseInput({ measured }), 'flow-layered');
    expect(r.collisions.overlappingPairs).toHaveLength(0);
    const r2 = layoutTree(baseInput({ measured }), 'flow-layered');
    expect(r.positions).toEqual(r2.positions);
  });

  it('环输入：不死循环、主树退化分层不逆层', () => {
    // a→b→c→a 纯环：字典序强取 a 为根，主树 a→b→c。
    const nodes = ['a', 'b', 'c'].map(makeNode);
    const edges = [
      makeEdge('e_ab', 'a', 'b'),
      makeEdge('e_bc', 'b', 'c'),
      makeEdge('e_ca', 'c', 'a'),
    ];
    const r = layoutTree(
      { nodes, edges, rankSpacing: 90, nodeSpacing: 28, measured: {} },
      'flow-layered',
    );
    // 三节点都有位置（不死循环）。
    expect(Object.keys(r.positions).sort()).toEqual(['a', 'b', 'c']);
    // 主树 a→b→c 不逆层。
    expect(r.positions['a']!.y).toBeLessThan(r.positions['b']!.y);
    expect(r.positions['b']!.y).toBeLessThan(r.positions['c']!.y);
    expect(r.notes.some((n) => n.includes('成环'))).toBe(true);
  });

  it('组合：collapsed 剔除后代、pinned 坐标不变且绕行、仅选中分支子集', () => {
    // collapsed：b 折叠 → d/e/f 无位置。
    const rc = layoutTree(baseInput({ collapsed: { b: true } }), 'flow-layered');
    expect(rc.positions['b']).toBeDefined();
    expect(rc.positions['d']).toBeUndefined();
    expect(rc.positions['e']).toBeUndefined();
    expect(rc.positions['f']).toBeUndefined();

    // pinned：b 钉在 (0,0)，坐标严格不变、无残留重叠。
    const { nodes, edges } = buildFixture();
    const bNode = nodes.find((n) => n.id === 'b')!;
    bNode.x = 0;
    bNode.y = 0;
    const rp = layoutTree(
      { nodes, edges, rankSpacing: 90, nodeSpacing: 28, measured: {}, pinned: new Set(['b']) },
      'flow-layered',
    );
    expect(rp.positions['b']).toEqual({ x: 0, y: 0 });
    expect(rp.collisions.overlappingPairs).toHaveLength(0);

    // 仅选中分支：只返回子集位置。
    const subset = [makeNode('a'), makeNode('b')];
    const rs = layoutTree(
      { nodes: subset, edges, rankSpacing: 90, nodeSpacing: 28, measured: {} },
      'flow-layered',
    );
    expect(Object.keys(rs.positions).sort()).toEqual(['a', 'b']);
  });

  it('tighten：notes 标注且不产生重叠', () => {
    const r = layoutTree(baseInput({ tighten: true }), 'flow-layered');
    expect(r.collisions.overlappingPairs).toHaveLength(0);
    expect(r.notes.some((n) => n.includes('tighten'))).toBe(true);
  });

  it('增量整理：flow-layered 走 incremental 管线、未受影响分支冻结', () => {
    const positions0 = layoutTree(baseInput(), 'flow-layered').positions;
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
      'flow-layered',
    );
    for (const id of ['a', 'c', 'g']) {
      expect(inc.positions[id]).toEqual(positions0[id]);
    }
    expect(inc.positions['h']).toBeDefined();
  });
});

/**
 * 从布局结果反推分层 order（同层顶对齐 → y 严格聚成一行；行内按 x 排序）。
 * 供 countLayerCrossings 黑盒校验「迭代后交叉数」。
 */
function layerOrderFromResult(positions: Record<string, LayoutPosition>): {
  order: Map<number, string[]>;
  rankOf: Map<string, number>;
} {
  const yToIds = new Map<number, string[]>();
  for (const [id, p] of Object.entries(positions)) {
    const arr = yToIds.get(p.y) ?? [];
    arr.push(id);
    yToIds.set(p.y, arr);
  }
  const rows = [...yToIds.entries()].sort((a, b) => a[0] - b[0]);
  const order = new Map<number, string[]>();
  const rankOf = new Map<string, number>();
  rows.forEach(([, ids], rank) => {
    ids.sort((a, b) => positions[a]!.x - positions[b]!.x);
    order.set(rank, ids);
    for (const id of ids) rankOf.set(id, rank);
  });
  return { order, rankOf };
}

/**
 * 多父 DAG（Wave22 barycenter 验证）：
 *        A
 *    /   |   \
 *   B    C    F
 *   |\  / \   |
 *   | \/   \  |
 *   D  E    G
 *
 * 主树（首条入边 wins）：A→B,C,F；B→D；C→E；F→G。
 * 额外多父边：B→E、C→D、C→G、F→D（制造相邻层父子边交叉）。
 * 贪心父序层2 = [D,E,G] 时相邻层交叉 = 4；barycenter 排序后 = 2。
 */
function buildMultiParentDag(): { nodes: BlockNode[]; edges: Edge[] } {
  const nodes = ['A', 'B', 'C', 'F', 'D', 'E', 'G'].map(makeNode);
  const edges = [
    makeEdge('e_AB', 'A', 'B'),
    makeEdge('e_AC', 'A', 'C'),
    makeEdge('e_AF', 'A', 'F'),
    // 主父（首条入边 wins）
    makeEdge('e_BD', 'B', 'D'),
    makeEdge('e_CE', 'C', 'E'),
    makeEdge('e_FG', 'F', 'G'),
    // 多父边
    makeEdge('e_BE', 'B', 'E'),
    makeEdge('e_CD', 'C', 'D'),
    makeEdge('e_CG', 'C', 'G'),
    makeEdge('e_FD', 'F', 'D'),
  ];
  return { nodes, edges };
}

describe('layout / flow-layered 层内 barycenter 交叉最小化（Wave22）', () => {
  it('countLayerCrossings：纯函数正确数相邻层父子边交叉', () => {
    // 层1 [B,C]；层2 [D,E]。边 B→D,B→E,C→D,C→E（K2,2）→ 交叉 = 1。
    const order = new Map<number, string[]>([
      [1, ['B', 'C']],
      [2, ['D', 'E']],
    ]);
    const rankOf = new Map<string, number>([
      ['B', 1], ['C', 1], ['D', 2], ['E', 2],
    ]);
    const edges = [
      { source: 'B', target: 'D' },
      { source: 'B', target: 'E' },
      { source: 'C', target: 'D' },
      { source: 'C', target: 'E' },
    ];
    expect(countLayerCrossings(order, edges, rankOf)).toBe(1);

    // 同序层内无交叉：层2 调成 [E,D] 后 K2,2 交叉仍 = 1（对偶）。
    const order2 = new Map<number, string[]>([
      [1, ['B', 'C']],
      [2, ['E', 'D']],
    ]);
    expect(countLayerCrossings(order2, edges, rankOf)).toBe(1);

    // 非相邻层边不计数。
    const longEdge = [...edges, { source: 'A', target: 'E' }];
    expect(countLayerCrossings(order, longEdge, rankOf)).toBe(1);
  });

  it('多父 DAG：barycenter 迭代后相邻层父子边交叉严格下降', () => {
    const { nodes, edges } = buildMultiParentDag();
    const input: LayoutInput = { nodes, edges, rankSpacing: 90, nodeSpacing: 28, measured: {} };

    // 迭代前 = 贪心父序铺栏（层0[A]，层1[B,C,F]，层2 按主父列 [D,E,G]）。
    const greedyOrder = new Map<number, string[]>([
      [0, ['A']],
      [1, ['B', 'C', 'F']],
      [2, ['D', 'E', 'G']],
    ]);
    const rankOfGreedy = new Map<string, number>([
      ['A', 0], ['B', 1], ['C', 1], ['F', 1], ['D', 2], ['E', 2], ['G', 2],
    ]);
    const before = countLayerCrossings(greedyOrder, edges, rankOfGreedy);
    expect(before).toBe(4);

    const r = layoutTree(input, 'flow-layered');
    const { order, rankOf } = layerOrderFromResult(r.positions);
    const after = countLayerCrossings(order, edges, rankOf);
    expect(after).toBeLessThan(before);
    expect(after).toBe(2);
    expect(r.notes.some((n) => n.includes('barycenter'))).toBe(true);
    // 无残留重叠。
    expect(r.collisions.overlappingPairs).toHaveLength(0);
  });

  it('单树：零交叉、子树仍按父序聚拢（barycenter 不动点）、确定性', () => {
    const r1 = layoutTree(baseInput(), 'flow-layered');
    const r2 = layoutTree(baseInput(), 'flow-layered');
    expect(r1).toEqual(r2);
    const { order, rankOf } = layerOrderFromResult(r1.positions);
    expect(countLayerCrossings(order, baseInput().edges, rankOf)).toBe(0);
    // 层1 = [b, c]；层2 = [d, e, g]（d/e 父 b 聚拢、在 g 前）——与改造前一致。
    expect(order.get(1)).toEqual(['b', 'c']);
    expect(order.get(2)).toEqual(['d', 'e', 'g']);
  });

  it('单链 DAG：逐层加深、零交叉、确定性', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const nodes = ids.map(makeNode);
    const edges = ids.slice(1).map((t, i) => makeEdge(`e${i}`, ids[i]!, t));
    const r = layoutTree({ nodes, edges, rankSpacing: 90, nodeSpacing: 28, measured: {} }, 'flow-layered');
    const { order, rankOf } = layerOrderFromResult(r.positions);
    expect(countLayerCrossings(order, edges, rankOf)).toBe(0);
    expect(r.collisions.overlappingPairs).toHaveLength(0);
  });

  it('多根森林：零交叉、根块互不穿插；跨根多父边不致子树交错', () => {
    const nodes = ['r1', 'r2', 'a1', 'b1', 'c1'].map(makeNode);
    const edges = [
      makeEdge('e1', 'r1', 'a1'),
      makeEdge('e2', 'r2', 'b1'),
      makeEdge('e3', 'b1', 'c1'),
      makeEdge('e4', 'r2', 'a1'), // 跨根额外父：试图把 a1 拉向 r2 块
    ];
    const r = layoutTree({ nodes, edges, rankSpacing: 90, nodeSpacing: 28, measured: {} }, 'flow-layered');
    const { order, rankOf } = layerOrderFromResult(r.positions);
    expect(countLayerCrossings(order, edges, rankOf)).toBe(0);
    // rank0 根字典序 [r1, r2]；层1 a1（r1 块）仍在 b1（r2 块）之前——块隔离。
    expect(order.get(0)).toEqual(['r1', 'r2']);
    expect(order.get(1)).toEqual(['a1', 'b1']);
  });

  it('诱导震荡输入：有界终止、交叉不反弹、确定性', () => {
    // K2,2 完全二分：任意层2排列交叉恒为 1（下界），barycenter 首轮无严格改善即停。
    const nodes = ['A', 'B', 'C', 'D', 'E'].map(makeNode);
    const edges = [
      makeEdge('ab', 'A', 'B'),
      makeEdge('ac', 'A', 'C'),
      makeEdge('bd', 'B', 'D'),
      makeEdge('be', 'B', 'E'),
      makeEdge('cd', 'C', 'D'),
      makeEdge('ce', 'C', 'E'),
    ];
    const input: LayoutInput = { nodes, edges, rankSpacing: 90, nodeSpacing: 28, measured: {} };
    const r1 = layoutTree(input, 'flow-layered');
    const r2 = layoutTree(input, 'flow-layered');
    expect(r1).toEqual(r2); // 确定性、必然终止
    const { order, rankOf } = layerOrderFromResult(r1.positions);
    expect(countLayerCrossings(order, edges, rankOf)).toBe(1); // 下界，不反弹
  });

  it('组合：成环退化不死循环、pinned 坐标不变、collapsed 剔除后代、不回退', () => {
    // 成环：a→b→c→a，字典序强取 a 为根。
    const cycleNodes = ['a', 'b', 'c'].map(makeNode);
    const cycleEdges = [
      makeEdge('ab', 'a', 'b'),
      makeEdge('bc', 'b', 'c'),
      makeEdge('ca', 'c', 'a'),
    ];
    const rc = layoutTree(
      { nodes: cycleNodes, edges: cycleEdges, rankSpacing: 90, nodeSpacing: 28, measured: {} },
      'flow-layered',
    );
    expect(Object.keys(rc.positions).sort()).toEqual(['a', 'b', 'c']);
    expect(rc.positions['a']!.y).toBeLessThan(rc.positions['b']!.y);

    // pinned：b 钉 (0,0)，坐标严格不变、无残留重叠。
    const { nodes: fn, edges: fe } = buildFixture();
    const bNode = fn.find((n) => n.id === 'b')!;
    bNode.x = 0;
    bNode.y = 0;
    const rp = layoutTree(
      { nodes: fn, edges: fe, rankSpacing: 90, nodeSpacing: 28, measured: {}, pinned: new Set(['b']) },
      'flow-layered',
    );
    expect(rp.positions['b']).toEqual({ x: 0, y: 0 });
    expect(rp.collisions.overlappingPairs).toHaveLength(0);

    // collapsed：折叠 b → d/e/f 后代无位置。
    const rt = layoutTree(baseInput({ collapsed: { b: true } }), 'flow-layered');
    expect(rt.positions['b']).toBeDefined();
    expect(rt.positions['d']).toBeUndefined();
    expect(rt.positions['e']).toBeUndefined();
  });

  it('多父 DAG + pinned：仍能压低交叉且 pinned 不动、不崩溃', () => {
    const { nodes, edges } = buildMultiParentDag();
    // 把根 A 钉在左上角。
    const aNode = nodes.find((n) => n.id === 'A')!;
    aNode.x = 0;
    aNode.y = 0;
    const r = layoutTree(
      { nodes, edges, rankSpacing: 90, nodeSpacing: 28, measured: {}, pinned: new Set(['A']) },
      'flow-layered',
    );
    expect(r.positions['A']).toEqual({ x: 0, y: 0 });
    expect(r.collisions.overlappingPairs).toHaveLength(0);
    const { order, rankOf } = layerOrderFromResult(r.positions);
    // 非钉节点仍有排布，交叉 ≤ 贪心基线 4。
    expect(order.size).toBeGreaterThan(0);
    expect(countLayerCrossings(order, edges, rankOf)).toBeLessThanOrEqual(4);
  });
});
