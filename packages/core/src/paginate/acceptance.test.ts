import { describe, it, expect } from 'vitest';
import type { BlockNode, Edge } from '../model/index.js';
import { layoutTree } from '../layout/index.js';
import type { LayoutResult, MeasuredSize } from '../layout/index.js';
import { contentRect, mmToPx } from './constants.js';
import {
  paginateFit,
  paginateTiles,
  paginateFlow,
  type PaginateInput,
  type PaginateSettings,
} from './paginate.js';

/**
 * §9 导出硬性验收（core 级强断言）。
 *
 * 标准验收样例：30 个块、≥3 种块型、≥4 层父子树、横向一页放不下；
 * 另造 1 个与主体无边连接的孤块、1 个折叠子树。
 * 对 tiles/flow/fit 三模式做「节点绘制矩形完全落在内容区内」的像素级测量。
 */

interface Fixture {
  nodes: BlockNode[];
  edges: Edge[];
  measured: Record<string, MeasuredSize>;
  orphanId: string;
  collapsedId: string;
  collapsedDescendants: string[];
}

let nid = 0;
function makeNode(id: string, type: BlockNode['type'], x: number, y: number, collapsed = false): BlockNode {
  return {
    id,
    type,
    x,
    y,
    width: 240,
    height: 72,
    content: { format: 'tiptap-json', data: { type: 'doc', content: [] } },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed,
    tags: [],
    style: {},
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

/** 构造一棵 ≥4 层、约 30 节点的树 + 1 孤块 + 1 折叠子树。 */
function buildFixture(): Fixture {
  const nodes: BlockNode[] = [];
  const edges: Edge[] = [];
  const measured: Record<string, MeasuredSize> = {};
  const push = (n: BlockNode) => {
    nodes.push(n);
    measured[n.id] = { width: n.width, height: n.height };
  };

  // 主树：root → 3 个一级子；每个一级子再展开，凑 30 节点、4+ 层。
  const types: BlockNode['type'][] = ['heading', 'text', 'todo', 'note', 'bullet'];
  const root = makeNode('n_root', 'heading', 0, 0);
  push(root);

  let counter = 0;
  const addChild = (parentId: string, depth: number, maxDepth: number): string => {
    const id = `n_${nid++}`;
    const type = types[counter++ % types.length]!;
    push(makeNode(id, type, 0, 0));
    edges.push(makeEdge(`e_${id}`, parentId, id));
    if (depth < maxDepth) {
      const kids = depth === 0 ? 3 : 2;
      for (let k = 0; k < kids; k++) addChild(id, depth + 1, maxDepth);
    }
    return id;
  };
  // root 的 3 个一级子，各自 3 层 → 深度达 4。
  for (let k = 0; k < 3; k++) addChild('n_root', 1, 4);

  // 折叠子树：挑一个「有后代且非根、较深」的节点折叠（剔除其后裔但保留主干）。
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    const arr = childrenOf.get(e.source) ?? [];
    arr.push(e.target);
    childrenOf.set(e.source, arr);
  }
  const depthOf = new Map<string, number>();
  depthOf.set('n_root', 0);
  const dfs = (id: string) => {
    const d = depthOf.get(id) ?? 0;
    for (const c of childrenOf.get(id) ?? []) {
      depthOf.set(c, d + 1);
      dfs(c);
    }
  };
  dfs('n_root');
  let collapsedId = '';
  for (const nd of nodes) {
    if (nd.id === 'n_root') continue;
    const d = depthOf.get(nd.id) ?? 0;
    const kids = childrenOf.get(nd.id) ?? [];
    if (d >= 2 && kids.length > 0) {
      collapsedId = nd.id;
      break;
    }
  }
  const collapsedDescendants: string[] = [];
  const stack = [...(childrenOf.get(collapsedId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    collapsedDescendants.push(id);
    stack.push(...(childrenOf.get(id) ?? []));
  }

  // 孤块：与主体无边连接，放在远处。
  const orphanId = 'n_orphan';
  push(makeNode(orphanId, 'note', 5000, 5000));

  return { nodes, edges, measured, orphanId, collapsedId, collapsedDescendants };
}

function settings(over?: Partial<PaginateSettings>): PaginateSettings {
  return {
    size: 'A4',
    orientation: 'landscape',
    marginMm: 15,
    mode: 'tiles',
    showPageBreak: true,
    colorMode: 'color',
    header: true,
    footer: true,
    showPageNumbers: true,
    edgeLabels: true,
    pageBreaks: [],
    ...over,
  };
}

/** 测量：节点在该页的绘制矩形是否完全落在内容区内（零切割）。 */
function assertNodeContained(
  page: { nodeDrawOffsets?: Record<string, { x: number; y: number }>; scale: number },
  id: string,
  measured: Record<string, MeasuredSize>,
  cr: { x: number; y: number; width: number; height: number },
) {
  const off = page.nodeDrawOffsets?.[id];
  if (!off) throw new Error(`节点 ${id} 缺 nodeDrawOffsets`);
  const size = measured[id] ?? { width: 240, height: 72 };
  const s = page.scale || 1;
  const left = off.x;
  const top = off.y;
  const right = left + size.width * s;
  const bottom = top + size.height * s;
  const eps = 1.0; // 1px 容差
  expect(left).toBeGreaterThanOrEqual(cr.x - eps);
  expect(top).toBeGreaterThanOrEqual(cr.y - eps);
  expect(right).toBeLessThanOrEqual(cr.x + cr.width + eps);
  expect(bottom).toBeLessThanOrEqual(cr.y + cr.height + eps);
}

describe('§9 导出硬验收 / tiles', () => {
  it('标准 30 块样例：每节点完整且仅出现在一页（零切割）', () => {
    const fx = buildFixture();
    expect(fx.nodes.length).toBeGreaterThanOrEqual(30);
    const layout: LayoutResult = layoutTree(
      { nodes: fx.nodes, edges: fx.edges, rankSpacing: 90, nodeSpacing: 28, measured: fx.measured },
      'mindmap-right',
    );
    const collapsed: Record<string, boolean> = { [fx.collapsedId]: true };
    const input: PaginateInput = {
      layout,
      measured: fx.measured,
      settings: settings(),
      nodes: fx.nodes,
      edges: fx.edges,
      collapsed,
    };
    const result = paginateTiles(input);
    expect(result.totalPages).toBeGreaterThan(1); // 横向一页放不下

    const cr = contentRect({ orientation: 'landscape', marginMm: 15, header: true, footer: true });

    // 每个 active 节点恰好出现在一页，且绘制矩形完全落在内容区内。
    const seen = new Map<string, number>();
    for (const page of result.pages) {
      for (const id of page.nodeIds) {
        seen.set(id, (seen.get(id) ?? 0) + 1);
        assertNodeContained(page, id, fx.measured, cr);
      }
    }
    for (const [id, count] of seen) {
      expect(count, `节点 ${id} 应只出现在一页`).toBe(1);
    }

    // 折叠子树后代全部缺席；折叠节点自身保留。
    for (const d of fx.collapsedDescendants) {
      for (const page of result.pages) expect(page.nodeIds).not.toContain(d);
    }
    expect(result.pages.some((p) => p.nodeIds.includes(fx.collapsedId))).toBe(true);

    // 孤块存在且被标黄警告。
    const orphanWarn = result.orphans.find((o) => o.nodeId === fx.orphanId);
    expect(orphanWarn, '孤块应有 OrphanWarning').toBeTruthy();
    expect(result.pages.some((p) => p.nodeIds.includes(fx.orphanId))).toBe(true);

    // 跨页边：续接标记成对、token 相同、互为 peer。
    const byToken = new Map<string, typeof result.pages[number]['continuations']>();
    for (const page of result.pages) {
      for (const c of page.continuations) {
        const arr = byToken.get(c.token) ?? [];
        arr.push(c);
        byToken.set(c.token, arr);
      }
    }
    for (const [token, markers] of byToken) {
      expect(markers.length, `token ${token} 应成对`).toBe(2);
      expect(markers[0]!.peerPageIndex).toBe(markers[1]!.pageIndex);
      expect(markers[1]!.peerPageIndex).toBe(markers[0]!.pageIndex);
    }
  });
});

describe('§9 导出硬验收 / flow', () => {
  it('每节点完整落在一页、折叠后代缺席、超高块 error', () => {
    const fx = buildFixture();
    const layout: LayoutResult = layoutTree(
      { nodes: fx.nodes, edges: fx.edges, rankSpacing: 90, nodeSpacing: 28, measured: fx.measured },
      'mindmap-down',
    );
    const collapsed: Record<string, boolean> = { [fx.collapsedId]: true };
    const input: PaginateInput = {
      layout,
      measured: fx.measured,
      settings: settings({ orientation: 'portrait', mode: 'flow' }),
      nodes: fx.nodes,
      edges: fx.edges,
      collapsed,
    };
    const result = paginateFlow(input);
    const cr = contentRect({ orientation: 'portrait', marginMm: 15, header: true, footer: true });

    // 每个 active 节点恰好一页，绘制矩形不越界。
    const seen = new Map<string, number>();
    for (const page of result.pages) {
      for (const id of page.nodeIds) {
        seen.set(id, (seen.get(id) ?? 0) + 1);
        assertNodeContained(page, id, fx.measured, cr);
      }
    }
    for (const [_id, count] of seen) expect(count).toBe(1);

    for (const d of fx.collapsedDescendants) {
      for (const page of result.pages) expect(page.nodeIds).not.toContain(d);
    }

    // 超高块 → error。
    const bigId = 'n_big';
    const bigNode = makeNode(bigId, 'text', 0, 0);
    bigNode.height = 5000;
    const flowMeasured = { ...fx.measured, [bigId]: { width: 240, height: 5000 } };
    const bigLayout: LayoutResult = {
      positions: { ...layout.positions, [bigId]: { x: 0, y: 0 } },
      collisions: { overlappingPairs: [], detouredNodes: [] },
      notes: [],
    };
    const bigResult = paginateFlow({
      layout: bigLayout,
      measured: flowMeasured,
      settings: settings({ orientation: 'portrait', mode: 'flow' }),
      nodes: [...fx.nodes, bigNode],
      edges: fx.edges,
    });
    const err = bigResult.orphans.find((o) => o.nodeId === bigId);
    expect(err?.severity).toBe('error');
  });
});

describe('§9 导出硬验收 / fit', () => {
  it('小图单页等比；超大图 scale<0.25 退化多页', () => {
    // 小图：单页。
    const smallLayout: LayoutResult = {
      positions: { a: { x: 0, y: 0 } },
      collisions: { overlappingPairs: [], detouredNodes: [] },
      notes: [],
    };
    const small = paginateFit({
      layout: smallLayout,
      measured: { a: { width: 200, height: 100 } },
      settings: settings(),
    });
    expect(small.pages).toHaveLength(1);
    expect(small.pages[0]!.scale).toBeGreaterThan(0);

    // 超大图：包围盒 10000×10000，naturalScale<0.25 → 多页。
    const bigPositions: Record<string, { x: number; y: number }> = {};
    const bigMeasured: Record<string, MeasuredSize> = {};
    for (let i = 0; i < 40; i++) {
      bigPositions[`n${i}`] = { x: i * 300, y: i * 300 };
      bigMeasured[`n${i}`] = { width: 200, height: 100 };
    }    const bigLayout: LayoutResult = {
      positions: bigPositions,
      collisions: { overlappingPairs: [], detouredNodes: [] },
      notes: [],
    };
    const big = paginateFit({ layout: bigLayout, measured: bigMeasured, settings: settings() });
    expect(big.pages.length).toBeGreaterThan(1);
    expect(big.pages[0]!.scale).toBeCloseTo(0.25, 5);
    expect(big.notes.join()).toMatch(/退化/);
  });
});

// 让 mmToPx 被引用（页边距常量在测量中间接使用）。
void mmToPx;
