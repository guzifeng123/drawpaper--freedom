import { describe, it, expect } from 'vitest';
import {
  planBentEdgeSegments,
  pageContainingPoint,
  unitDir,
  dirToAngle,
  type Pt,
  type PageRect,
} from './edge-crossing.js';

/**
 * edge-crossing 纯几何单测：跨页段的切线方向（dir）必须与顶点走向一致；
 * 出页/入页两侧共享同一方向（成对自洽）。
 */

const page = (index: number, x: number, y: number, w = 800, h = 1000): PageRect => ({
  index,
  worldRect: { x, y, width: w, height: h },
});

describe('edge-crossing / 方向向量', () => {
  it('unitDir 归一化、反向量对称', () => {
    const d = unitDir({ x: 0, y: 0 }, { x: 300, y: 400 });
    expect(d.x).toBeCloseTo(0.6);
    expect(d.y).toBeCloseTo(0.8);
    // 零长度兜底 (1,0)
    expect(unitDir({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 1, y: 0 });
  });

  it('dirToAngle：水平向右=0、竖直向下=π/2', () => {
    expect(dirToAngle({ x: 1, y: 0 })).toBeCloseTo(0);
    expect(dirToAngle({ x: 0, y: 1 })).toBeCloseTo(Math.PI / 2);
    expect(dirToAngle({ x: -1, y: 0 })).toBeCloseTo(Math.PI);
  });

  it('跨页段：dir = 从段起点指向段终点（边的前进方向）', () => {
    // 页0: [0,0]-[800,1000]，页1: [750,0]-[1550,1000]（50px 重叠带）。
    const pages = [page(0, 0, 0), page(1, 750, 0)];
    const vertices: Pt[] = [
      { x: 100, y: 500 }, // 页0
      { x: 1200, y: 500 }, // 页1
    ];
    const { crossPairs } = planBentEdgeSegments(vertices, pages);
    expect(crossPairs).toHaveLength(1);
    const cp = crossPairs[0]!;
    expect(cp.pageA).toBe(0);
    expect(cp.pageB).toBe(1);
    // 走向向右 → dir ≈ +x，angle ≈ 0（出页侧朝右出页、入页侧朝右入页）
    expect(cp.dir.x).toBeCloseTo(1);
    expect(cp.dir.y).toBeCloseTo(0);
    expect(dirToAngle(cp.dir)).toBeCloseTo(0);
  });

  it('竖直跨页：dir 向下（angle=π/2）', () => {
    const pages = [page(0, 0, 0, 800, 1000), page(1, 0, 950, 800, 1000)];
    const vertices: Pt[] = [
      { x: 400, y: 200 },
      { x: 400, y: 1500 },
    ];
    const { crossPairs } = planBentEdgeSegments(vertices, pages);
    expect(crossPairs).toHaveLength(1);
    expect(crossPairs[0]!.dir.y).toBeCloseTo(1);
    expect(crossPairs[0]!.dir.x).toBeCloseTo(0);
  });

  it('斜向跨页：dir 与顶点走向严格同方向（成对两侧共享）', () => {
    const pages = [page(0, 0, 0), page(1, 750, 0)];
    const vertices: Pt[] = [
      { x: 100, y: 200 },
      { x: 900, y: 800 },
    ];
    const { crossPairs } = planBentEdgeSegments(vertices, pages);
    const cp = crossPairs[0]!;
    // (800,600) 归一化 = (0.8,0.6)
    expect(cp.dir.x).toBeCloseTo(0.8);
    expect(cp.dir.y).toBeCloseTo(0.6);
  });

  it('同页段不产生跨页对；pageContainingPoint 含重叠带判定', () => {
    const pages = [page(0, 0, 0), page(1, 750, 0)];
    const vertices: Pt[] = [
      { x: 100, y: 100 },
      { x: 400, y: 200 },
    ];
    const { samePageEdges, crossPairs } = planBentEdgeSegments(vertices, pages);
    expect(samePageEdges).toEqual([0]);
    expect(crossPairs).toHaveLength(0);
    // 重叠带内的点（x=760）落在页0
    expect(pageContainingPoint({ x: 760, y: 100 }, pages)).toBe(0);
  });
});
