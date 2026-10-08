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

  it('超大内容（scale<0.25）退化为多页（裁剪后仍多页）', () => {
    // 4 个节点铺在 4000×4000 四角：naturalScale≈0.17<0.25 → 退化 tiles；
    // 四角节点各占一页（无空白页可裁），裁剪后仍 >1 页。
    const input = fitInput(
      { a: { x: 0, y: 0 }, b: { x: 4000, y: 0 }, c: { x: 0, y: 4000 }, d: { x: 4000, y: 4000 } },
      { a: { width: 400, height: 300 }, b: { width: 400, height: 300 }, c: { width: 400, height: 300 }, d: { width: 400, height: 300 } },
    );
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

  it('弯折边折线穿越 3 页：3 页都含该边、marker 成对且 peer 互指', () => {
    // n1(0,0) 右锚点(260,40)；n2(1500,0) 左锚点(1500,40)；points 横向穿过页0→页1→页2。
    const edge: Edge = {
      ...makeEdge('e_bend', 'n1', 'n2'),
      points: [
        { x: 1200, y: 40 },
        { x: 2400, y: 40 },
      ],
    };
    const input = tilesInput(
      { n1: { x: 0, y: 0 }, n2: { x: 4000, y: 0 } },
      { n1: { width: 260, height: 80 }, n2: { width: 260, height: 80 } },
      [edge],
    );
    const r = paginateTiles(input);
    expect(r.pages.length).toBeGreaterThanOrEqual(3);
    // 3 页都含该边（page0/page2 经 marker，page1 经 edgeId+marker）
    const perPage = r.pages.map((p) => ({
      edges: p.edgeIds.filter((id) => id === 'e_bend').length,
      markers: p.continuations.filter((c) => c.edgeId === 'e_bend'),
    }));
    const touched = perPage.filter((p) => p.edges > 0 || p.markers.length > 0);
    expect(touched.length).toBeGreaterThanOrEqual(3);
    // 至少两对跨页 marker（起点/终点跨页 + 中间弯折跨页），总数为偶数
    const all = r.pages.flatMap((p) => p.continuations).filter((c) => c.edgeId === 'e_bend');
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(all.length % 2).toBe(0);
    // 每对 token 相同、peer 互指
    const byToken = new Map<string, typeof all>();
    for (const c of all) {
      const arr = byToken.get(c.token) ?? [];
      arr.push(c);
      byToken.set(c.token, arr);
    }
    for (const group of byToken.values()) {
      expect(group).toHaveLength(2);
      expect(group[0]!.peerPageIndex).toBe(group[1]!.pageIndex);
      expect(group[1]!.peerPageIndex).toBe(group[0]!.pageIndex);
    }
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

  it('跨页边成对续接标记：angle 两侧相等、out/in 成对、方向沿边走向', () => {
    // n1(0,0) → n2(1000,0) 水平向右跨页。
    const input = tilesInput(
      { n1: { x: 0, y: 0 }, n2: { x: 1000, y: 0 } },
      { n1: { width: 260, height: 80 }, n2: { width: 260, height: 80 } },
      [makeEdge('e_dir', 'n1', 'n2')],
    );
    const r = paginateTiles(input);
    const all = r.pages.flatMap((p) => p.continuations);
    expect(all).toHaveLength(2);
    const [a, b] = all;
    // 同 token、peer 互指。
    expect(a!.token).toBe(b!.token);
    expect(a!.peerPageIndex).toBe(b!.pageIndex);
    expect(b!.peerPageIndex).toBe(a!.pageIndex);
    // out/in 成对（源侧=out，目标侧=in）。
    const roles = [a!.role, b!.role].sort().join(',');
    expect(roles).toBe('in,out');
    // 两侧角度相等（切页边界切线自洽），水平向右 → angle≈0。
    expect(a!.angle).toBeCloseTo(b!.angle, 6);
    expect(a!.angle).toBeCloseTo(0, 3);
    // out 侧在源节点所在页。
    const outMarker = a!.role === 'out' ? a! : b!;
    expect(outMarker.pageIndex).toBe(
      r.pages.findIndex((p) => p.nodeIds.includes('n1')),
    );
  });

  it('竖直跨页边：angle≈π/2（边向下走）', () => {
    // top 右锚点 (260,40)；bottom 左锚点落在 x=260 → 边走向纯竖直向下。
    const input = tilesInput(
      { top: { x: 0, y: 0 }, bottom: { x: 260, y: 1500 } },
      { top: { width: 260, height: 80 }, bottom: { width: 260, height: 80 } },
      [makeEdge('e_v', 'top', 'bottom')],
    );
    const r = paginateTiles(input);
    const all = r.pages.flatMap((p) => p.continuations);
    expect(all).toHaveLength(2);
    expect(all[0]!.angle).toBeCloseTo(all[1]!.angle, 6);
    expect(all[0]!.angle).toBeCloseTo(Math.PI / 2, 3);
  });
});

describe('paginate / tiles 空白页裁剪与重编号', () => {
  function sparseInput(over?: Partial<PaginateSettings>, edges: Edge[] = []): PaginateInput {
    // n1/n2 主簇跨页相连；n3 孤块甩到远处（5000,5000），撑出大网格却无节点。
    const positions = {
      n1: { x: 0, y: 0 },
      n2: { x: 900, y: 0 },
      n3: { x: 5000, y: 5000 },
    };
    const measured = {
      n1: { width: 260, height: 80 },
      n2: { width: 260, height: 80 },
      n3: { width: 260, height: 80 },
    };
    return {
      layout: makeLayout(positions),
      measured,
      settings: makeSettings(over),
      edges,
    };
  }

  it('稀疏夹具：网格空白页被裁，剩余页连续重编号', () => {
    const edges = [makeEdge('e_cross', 'n1', 'n2')];
    const r = paginateTiles(sparseInput({}, edges));
    // 原始 2 列 × 6 行 = 12 页，仅 3 页有节点 → 裁到 3 页。
    expect(r.pages.length).toBe(3);
    expect(r.totalPages).toBe(3);
    // 页码连续 0,1,2。
    r.pages.forEach((p, i) => {
      expect(p.index).toBe(i);
      expect(p.pageNumber).toBe(i);
    });
    // 无任何零节点残留页。
    for (const p of r.pages) expect(p.nodeIds.length).toBeGreaterThan(0);
    // 三个节点各在一页。
    const allNodes = r.pages.flatMap((p) => p.nodeIds).sort();
    expect(allNodes).toEqual(['n1', 'n2', 'n3']);
  });

  it('裁剪后跨页续接标记仍成对且互指正确', () => {
    const edges = [makeEdge('e_cross', 'n1', 'n2')];
    const r = paginateTiles(sparseInput({}, edges));
    const markers = r.pages.flatMap((p) => p.continuations);
    expect(markers).toHaveLength(2);
    expect(markers[0]!.token).toBe(markers[1]!.token);
    // 互指：A.peer == B.pageIndex，B.peer == A.pageIndex。
    expect(markers[0]!.peerPageIndex).toBe(markers[1]!.pageIndex);
    expect(markers[1]!.peerPageIndex).toBe(markers[0]!.pageIndex);
    // marker 所在页索引合法（< 总页数）。
    for (const m of markers) {
      expect(m.pageIndex).toBeGreaterThanOrEqual(0);
      expect(m.pageIndex).toBeLessThan(r.totalPages);
      expect(m.peerPageIndex).toBeGreaterThanOrEqual(0);
      expect(m.peerPageIndex).toBeLessThan(r.totalPages);
    }
  });

  it('含节点页不被误裁（孤块页保留并标黄）', () => {
    const r = paginateTiles(sparseInput());
    // 孤块 n3 仍在导出中。
    expect(r.pages.some((p) => p.nodeIds.includes('n3'))).toBe(true);
    const warn = r.orphans.find((o) => o.nodeId === 'n3');
    expect(warn?.severity).toBe('warn');
  });

  it('手动分页符切出的空白页保留（不裁剪）', () => {
    // n_a 在页顶、n_b 在下一页；手动符在页 0 中部 → 页 0 被切成两带，上带含 n_a、下带空白。
    const positions = { n_a: { x: 0, y: 0 }, n_b: { x: 0, y: 1500 } };
    const measured = { n_a: { width: 200, height: 200 }, n_b: { width: 200, height: 200 } };
    const settings = makeSettings({ pageBreaks: [{ at: 600 }] });
    const input: PaginateInput = { layout: makeLayout(positions), measured, settings, edges: [] };
    const r = paginateTiles(input);
    // 上带(n_a) + 手动空白带(preserveBlank) + 下页(n_b) = 3 页。
    expect(r.pages.length).toBe(3);
    const blank = r.pages.find((p) => p.nodeIds.length === 0);
    expect(blank, '手动分页符产生的空白页应保留').toBeTruthy();
    expect(blank!.preserveBlank).toBe(true);
    // 页码仍连续。
    r.pages.forEach((p, i) => expect(p.index).toBe(i));
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

  it('多根森林：各根子树全部到场、零截断、块间距均匀（不孤悬空白）', () => {
    // 3 个互不相连的根 r0/r1/r2，各带 2 个 80px 子块。
    const positions: Record<string, { x: number; y: number }> = {};
    const measured: Record<string, MeasuredSize> = {};
    const edges: Edge[] = [];
    const ids: string[] = [];
    for (let ri = 0; ri < 3; ri++) {
      const root = `r${ri}`;
      ids.push(root);
      positions[root] = { x: 0, y: 0 };
      measured[root] = { width: 260, height: 80 };
      for (let ci = 0; ci < 2; ci++) {
        const kid = `r${ri}k${ci}`;
        ids.push(kid);
        positions[kid] = { x: 0, y: 0 };
        measured[kid] = { width: 260, height: 80 };
        edges.push(makeEdge(`e_${kid}`, root, kid));
      }
    }
    const r = paginateFlow(flowInput(positions, measured, edges));
    // 每个块恰好一页、零截断。
    for (const id of ids) {
      const pagesWith = r.pages.filter((p) => p.nodeIds.includes(id));
      expect(pagesWith, `${id} 应只出现一次`).toHaveLength(1);
    }
    // 9 块 × 88px = 792px < 内容区 ~1010 → 应全部落在一页（修正前因双占首子高度，
    // 块间距被拉宽一倍而撑出多页）。
    expect(r.pages.length).toBe(1);
    // 流序相邻块的纵向间距恒为 88（块高 80 + 间隙 8），无额外空白。
    // 与 DFS 展开顺序无关：按 y 排序后，相邻两快的差都必须是 88。
    const page = r.pages[0]!;
    const ys = ids
      .map((id) => page.nodeDrawOffsets![id]!.y)
      .sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) {
      const gap = ys[i]! - ys[i - 1]!;
      // 首块无前导间距（80），其后相邻块 = 块高 80 + 间隙 8 = 88；
      // 绝不能出现 ~176 的双占间距（游标按 clusterH 推进的旧病征）。
      const ok = Math.abs(gap - 80) < 1 || Math.abs(gap - 88) < 1;
      expect(ok, `相邻流块间距 ${gap} 异常`).toBe(true);
    }
    expect(ys[0]!).toBeCloseTo(contentRect({ orientation: 'portrait', marginMm: 15 }).y, 1);
  });

  it('多根森林跨页：根不在页边被截断、不出现某根孤悬整页空白', () => {
    // 2 个根，各带 3 个 300px 块 → 自然要翻页；验证每根都完整归属、无块越出内容区。
    const positions: Record<string, { x: number; y: number }> = {};
    const measured: Record<string, MeasuredSize> = {};
    const edges: Edge[] = [];
    const ids: string[] = [];
    for (let ri = 0; ri < 2; ri++) {
      const root = `rr${ri}`;
      ids.push(root);
      positions[root] = { x: 0, y: 0 };
      measured[root] = { width: 260, height: 300 };
      for (let ci = 0; ci < 3; ci++) {
        const kid = `rr${ri}k${ci}`;
        ids.push(kid);
        positions[kid] = { x: 0, y: 0 };
        measured[kid] = { width: 260, height: 300 };
        edges.push(makeEdge(`e_${kid}`, root, kid));
      }
    }
    const r = paginateFlow(flowInput(positions, measured, edges));
    const cr = contentRect({ orientation: 'portrait', marginMm: 15 });
    for (const p of r.pages) {
      for (const id of p.nodeIds) {
        const off = p.nodeDrawOffsets![id]!;
        const h = measured[id]!.height;
        expect(off.y).toBeGreaterThanOrEqual(cr.y - 1);
        expect(off.y + h).toBeLessThanOrEqual(cr.y + cr.height + 1);
      }
      // 每页至少 2 个块（不允许某一页只挂一个根、其余大片空白的失衡分页）。
      expect(p.nodeIds.length).toBeGreaterThanOrEqual(2);
    }
    for (const id of ids) {
      const pagesWith = r.pages.filter((p) => p.nodeIds.includes(id));
      expect(pagesWith).toHaveLength(1);
    }
  });
});
