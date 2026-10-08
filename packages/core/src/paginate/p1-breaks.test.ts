import { describe, it, expect } from 'vitest';
import type { BlockNode, Edge } from '../model/index.js';
import type { LayoutResult, MeasuredSize } from '../layout/index.js';
import { paginateFlow, paginateTiles, type PaginateInput, type PaginateSettings } from './paginate.js';

function node(id: string, x = 0, y = 0): BlockNode {
  return {
    id,
    type: 'text',
    x,
    y,
    width: 200,
    height: 300,
    content: { format: 'tiptap-json', data: { type: 'doc', content: [] } },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
  };
}
function edge(id: string, s: string, t: string): Edge {
  return { id, source: s, target: t, sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#999' } };
}

function baseSettings(): PaginateSettings {
  return {
    size: 'A4',
    orientation: 'portrait',
    marginMm: 15,
    mode: 'flow',
    showPageBreak: false,
    colorMode: 'color',
    header: false,
    footer: false,
    showPageNumbers: false,
    edgeLabels: true,
    pageBreaks: [],
  };
}

describe('flow 手动分页符', () => {
  // 4 个 300px 块的链；自然分页：前 3 块一页（约 924px < 1010 内容区），第 4 块翻页。
  const nodes = [node('n0'), node('n1'), node('n2'), node('n3')];
  const edges = [edge('e0', 'n0', 'n1'), edge('e1', 'n1', 'n2'), edge('e2', 'n2', 'n3')];
  const layout: LayoutResult = {
    positions: { n0: { x: 0, y: 0 }, n1: { x: 0, y: 0 }, n2: { x: 0, y: 0 }, n3: { x: 0, y: 0 } },
    collisions: { overlappingPairs: [], detouredNodes: [] },
    notes: [],
  };
  const measured: Record<string, MeasuredSize> = {
    n0: { width: 200, height: 300 },
    n1: { width: 200, height: 300 },
    n2: { width: 200, height: 300 },
    n3: { width: 200, height: 300 },
  };

  it('无手动符：簇规则下 n0/n1 同页、n2/n3 同页（游标按本块推进，不双占首子高度）', () => {
    const input: PaginateInput = { layout, measured, settings: baseSettings(), nodes, edges };
    const r = paginateFlow(input);
    // 300px 块 + 8px 间隙、内容区 ~1010px：n0(0)+n1(308)=608，n2 带首子簇需 616 → 翻页；
    // 翻页后 n2(0)+n3(308)=616 同页。共 2 页（修正前每父块预占首子高度，n0/n1 各独占一页）。
    expect(r.pages[0]!.nodeIds).toEqual(['n0', 'n1']);
    expect(r.pages[1]!.nodeIds).toEqual(['n2', 'n3']);
  });

  it('手动符在 n3 流坐标处：n3 另起一页', () => {
    const s = baseSettings();
    s.pageBreaks = [{ at: 924 }]; // n3 的流 y = 308*3 = 924（自然在 n2/n3 同页内）
    const input: PaginateInput = { layout, measured, settings: s, nodes, edges };
    const r = paginateFlow(input);
    expect(r.pages[1]!.nodeIds).toEqual(['n2']);
    expect(r.pages[2]!.nodeIds).toEqual(['n3']);
  });
});

describe('scopeBBox 框选过滤', () => {
  it('只保留与 bbox 相交的节点', () => {
    const nodes = [node('a', 0, 0), node('b', 2000, 0)];
    const layout: LayoutResult = {
      positions: { a: { x: 0, y: 0 }, b: { x: 2000, y: 0 } },
      collisions: { overlappingPairs: [], detouredNodes: [] },
      notes: [],
    };
    const measured: Record<string, MeasuredSize> = {
      a: { width: 200, height: 200 },
      b: { width: 200, height: 200 },
    };
    const input: PaginateInput = {
      layout,
      measured,
      settings: { ...baseSettings(), mode: 'tiles' },
      nodes,
      edges: [],
      scopeBBox: { x: -100, y: -100, width: 400, height: 400 },
    };
    const r = paginateTiles(input);
    const all = r.pages.flatMap((p) => p.nodeIds);
    expect(all).toContain('a');
    expect(all).not.toContain('b');
  });
});

describe('tiles 手动分页符', () => {
  it('切过分页符的页被拆分，总页数增加', () => {
    const nodes = [node('a', 0, 0), node('b', 0, 1500)];
    const layout: LayoutResult = {
      positions: { a: { x: 0, y: 0 }, b: { x: 0, y: 1500 } },
      collisions: { overlappingPairs: [], detouredNodes: [] },
      notes: [],
    };
    const measured: Record<string, MeasuredSize> = {
      a: { width: 200, height: 200 },
      b: { width: 200, height: 200 },
    };
    const settings = { ...baseSettings(), mode: 'tiles' as const };
    const base = paginateTiles({ layout, measured, settings, nodes, edges: [] });
    const s2 = { ...settings, pageBreaks: [{ at: 700 }] };
    const withBreak = paginateTiles({ layout, measured, settings: s2, nodes, edges: [] });
    expect(withBreak.totalPages).toBeGreaterThan(base.totalPages);
  });
});
