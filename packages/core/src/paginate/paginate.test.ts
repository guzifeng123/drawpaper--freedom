import { describe, it, expect } from 'vitest';
import type { BlockNode, Edge } from '../model/index.js';
import type { LayoutResult, MeasuredSize } from '../layout/index.js';
import {
  A4_PORTRAIT_PX,
  A4_LANDSCAPE_PX,
  mmToPx,
  pagePixelSize,
  contentRect,
} from './constants.js';
import {
  paginateFit,
  paginateTiles,
  paginateFlow,
  type PaginateInput,
  type PaginateSettings,
} from './paginate.js';

function makeSettings(over?: Partial<PaginateSettings>): PaginateSettings {
  return {
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
    ...over,
  };
}

function makeLayout(positions: Record<string, { x: number; y: number }>): LayoutResult {
  return {
    positions,
    collisions: { overlappingPairs: [], detouredNodes: [] },
    notes: [],
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

describe('paginate / constants', () => {
  it('A4 像素尺寸：纵向 794×1123，横向 1123×794', () => {
    expect(A4_PORTRAIT_PX.width).toBeCloseTo(794, 0);
    expect(A4_PORTRAIT_PX.height).toBeCloseTo(1123, 0);
    expect(A4_LANDSCAPE_PX.width).toBeCloseTo(1123, 0);
    expect(A4_LANDSCAPE_PX.height).toBeCloseTo(794, 0);
    expect(pagePixelSize('portrait')).toEqual(A4_PORTRAIT_PX);
    expect(pagePixelSize('landscape')).toEqual(A4_LANDSCAPE_PX);
  });

  it('mmToPx 换算正确', () => {
    expect(mmToPx(25.4)).toBeCloseTo(96, 5);
  });

  it('contentRect：10/15/20mm 边距数值', () => {
    for (const mm of [10, 15, 20] as const) {
      const cr = contentRect({ orientation: 'portrait', marginMm: mm });
      const m = mmToPx(mm);
      expect(cr.x).toBeCloseTo(m, 1);
      expect(cr.y).toBeCloseTo(m, 1);
      expect(cr.width).toBeCloseTo(A4_PORTRAIT_PX.width - m * 2, 1);
      expect(cr.height).toBeCloseTo(A4_PORTRAIT_PX.height - m * 2, 1);
    }
  });

  it('contentRect：页眉/页脚各预留 24px', () => {
    const cr = contentRect({
      orientation: 'portrait',
      marginMm: 10,
      header: true,
      footer: true,
    });
    const m = mmToPx(10);
    expect(cr.y).toBeCloseTo(m + 24, 1);
    expect(cr.height).toBeCloseTo(A4_PORTRAIT_PX.height - m * 2 - 48, 1);
  });
});

describe('paginate / fit', () => {
  function fitInput(
    positions: Record<string, { x: number; y: number }>,
    measured: Record<string, MeasuredSize>,
    over?: Partial<PaginateSettings>,
  ): PaginateInput {
    return {
      layout: makeLayout(positions),
      measured,
      settings: makeSettings(over),
    };
  }

  it('单页：内容等比铺满，scale 在 (0,2] 内', () => {
    // 内容 400×300，内容区约 680×1009 → scale≈min(680/400,1009/300)=1.7
    const input = fitInput({ n: { x: 0, y: 0 } }, { n: { width: 400, height: 300 } });
    const r = paginateFit(input);
    expect(r.pages).toHaveLength(1);
    const scale = r.pages[0]!.scale;
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThanOrEqual(2);
    expect(scale).toBeCloseTo(Math.min(680 / 400, 1009 / 300), 0);
  });

  it('超小内容不超过 2 倍放大', () => {
    const input = fitInput({ n: { x: 0, y: 0 } }, { n: { width: 10, height: 10 } });
    const r = paginateFit(input);
    expect(r.pages[0]!.scale).toBeLessThanOrEqual(2);
  });

  it('超大内容（scale<0.25）退化为多页', () => {
    // 内容 10000×10000 → naturalScale≈0.068 <0.25 → 退化 tiles
    const input = fitInput({ n: { x: 0, y: 0 } }, { n: { width: 10000, height: 10000 } });
    const r = paginateFit(input);
    expect(r.pages.length).toBeGreaterThan(1);
    expect(r.pages[0]!.scale).toBeCloseTo(0.25, 5);
    expect(r.notes.join()).toMatch(/退化/);
  });
});

describe('paginate / tiles', () => {
  function tilesInput(
    positions: Record<string, { x: number; y: number }>,
    measured: Record<string, MeasuredSize>,
    edges: Edge[],
    over?: Partial<PaginateSettings>,
  ): PaginateInput {
    return {
      layout: makeLayout(positions),
      measured,
      settings: makeSettings(over),
      edges,
    };
  }

  it('跨页边在两页各生成 1 个 marker 且 token 相同', () => {
    // 节点 n1 在世界 (0,0)，n2 在 (1000,0)，水平跨页。
    const input = tilesInput(
      { n1: { x: 0, y: 0 }, n2: { x: 1000, y: 0 } },
      { n1: { width: 260, height: 80 }, n2: { width: 260, height: 80 } },
      [makeEdge('e_cross', 'n1', 'n2')],
    );
    const r = paginateTiles(input);
    expect(r.pages.length).toBeGreaterThan(1);
    const allMarkers = r.pages.flatMap((p) => p.continuations);
    // 两个 marker，共享 token。
    expect(allMarkers).toHaveLength(2);
    expect(allMarkers[0]!.token).toBe(allMarkers[1]!.token);
    expect(allMarkers[0]!.edgeId).toBe('e_cross');
    // 互为 peerPageIndex。
    expect(allMarkers[0]!.peerPageIndex).toBe(allMarkers[1]!.pageIndex);
    expect(allMarkers[1]!.peerPageIndex).toBe(allMarkers[0]!.pageIndex);
  });

  it('跨边界节点整体只出现在一页', () => {
    // 节点 box [500,760]（宽 260），中心 630 落在第 0 页，但越右边界 → 挪到第 1 页。
    const input = tilesInput(
      { near: { x: 500, y: 0 } },
      { near: { width: 260, height: 80 } },
      [],
    );
    const r = paginateTiles(input);
    const pagesWithNode = r.pages.filter((p) => p.nodeIds.includes('near'));
    expect(pagesWithNode).toHaveLength(1);
  });
});

describe('paginate / flow', () => {
  function flowInput(
    positions: Record<string, { x: number; y: number }>,
    measured: Record<string, MeasuredSize>,
    edges: Edge[],
    over?: Partial<PaginateSettings>,
  ): PaginateInput {
    const nodes: BlockNode[] = Object.keys(positions).map((id) => ({
      id,
      type: 'text',
      x: 0,
      y: 0,
      width: 260,
      height: measured[id]?.height ?? 80,
      content: { format: 'tiptap-json' as const, data: {} },
      parentId: null,
      pinned: false,
      locked: false,
      collapsed: false,
      tags: [],
      style: {},
    }));
    return {
      layout: makeLayout(positions),
      measured,
      settings: makeSettings(over),
      edges,
      nodes,
    };
  }

  it('多页文档：每个节点完整落在某一页（不跨页截断）', () => {
    // 10 个高 400 的块，内容区高约 1009 → 多页。
    const positions: Record<string, { x: number; y: number }> = {};
    const measured: Record<string, MeasuredSize> = {};
    const edges: Edge[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `n${i}`;
      positions[id] = { x: 0, y: 0 };
      measured[id] = { width: 260, height: 400 };
      if (i > 0) edges.push(makeEdge(`e_${i}`, `n${i - 1}`, id));
    }
    const r = paginateFlow(flowInput(positions, measured, edges));
    expect(r.pages.length).toBeGreaterThan(1);
    // 每个节点恰好出现在一页。
    for (let i = 0; i < 10; i++) {
      const id = `n${i}`;
      const pagesWith = r.pages.filter((p) => p.nodeIds.includes(id));
      expect(pagesWith).toHaveLength(1);
    }
  });

  it('折叠后代不出现', () => {
    // a→b→c：折叠 b 后 c 不应出现在任何页。
    const input = flowInput(
      { a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, c: { x: 0, y: 0 } },
      { a: { width: 260, height: 80 }, b: { width: 260, height: 80 }, c: { width: 260, height: 80 } },
      [makeEdge('e_ab', 'a', 'b'), makeEdge('e_bc', 'b', 'c')],
    );
    input.collapsed = { b: true };
    const r = paginateFlow(input);
    for (const p of r.pages) {
      expect(p.nodeIds).not.toContain('c');
    }
    // b 自身保留。
    expect(r.pages.some((p) => p.nodeIds.includes('b'))).toBe(true);
  });

  it('单块高于一页内容区 → error 孤块警告', () => {
    const input = flowInput(
      { big: { x: 0, y: 0 } },
      { big: { width: 260, height: 5000 } },
      [],
    );
    const r = paginateFlow(input);
    const warn = r.orphans.find((o) => o.nodeId === 'big');
    expect(warn?.severity).toBe('error');
  });
});
