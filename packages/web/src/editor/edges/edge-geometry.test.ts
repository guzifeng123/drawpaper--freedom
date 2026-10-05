import { describe, expect, it } from 'vitest';
import {
  buildEdgePath,
  edgeMidpoint,
  edgeRectIntersections,
  insertBendPoint,
  removeBendPoint,
  translateBendPoints,
  distToSegment,
  type Rect,
} from './edge-geometry';

const S = { x: 0, y: 50, position: 'right' as const };
const T = { x: 200, y: 150, position: 'left' as const };

describe('edge-geometry', () => {
  it('无 points 产出贝塞尔 path（M...C...）', () => {
    const d = buildEdgePath(S, T);
    expect(d.startsWith('M 0 50 C')).toBe(true);
    expect(d).toContain('200 150');
  });

  it('空 points 数组等同缺省贝塞尔', () => {
    expect(buildEdgePath(S, T, [])).toBe(buildEdgePath(S, T));
  });

  it('有 points：source→p0 平滑、中间折线、pn→target 平滑', () => {
    const pts = [{ x: 80, y: 50 }, { x: 80, y: 150 }];
    const d = buildEdgePath(S, T, pts);
    expect(d).toContain('L 80 150');
    expect(d).toContain('80 50');
    expect(d.endsWith('200 150')).toBe(true);
    // 至少两段 C + 一段 L
    expect(d.match(/C/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('忽略非有限 points', () => {
    const d = buildEdgePath(S, T, [{ x: NaN, y: 1 } as never]);
    expect(d).toBe(buildEdgePath(S, T));
  });

  it('edgeMidpoint 为两端中点', () => {
    const m = edgeMidpoint(S, T);
    expect(m).toEqual({ x: 100, y: 100 });
  });

  it('edgeRectIntersections：直线穿过矩形返回两个交点', () => {
    const rect: Rect = { x: 50, y: 0, width: 100, height: 200 };
    // 从 (0,100) 到 (200,100) 水平穿过矩形左/右边
    const hits = edgeRectIntersections({ x: 0, y: 100 }, { x: 200, y: 100 }, undefined, rect);
    expect(hits.length).toBe(2);
    const xs = hits.map((h) => h.x).sort((a, b) => a - b);
    expect(xs).toEqual([50, 150]);
    expect(hits.every((h) => h.y === 100)).toBe(true);
  });

  it('edgeRectIntersections：折线绕过矩形返回 0 交点', () => {
    const rect: Rect = { x: 50, y: 0, width: 100, height: 100 };
    // 起点终点都在矩形右侧，折线不进矩形
    const hits = edgeRectIntersections({ x: 200, y: 50 }, { x: 300, y: 150 }, undefined, rect);
    expect(hits.length).toBe(0);
  });

  it('edgeRectIntersections：弯折点让折线进入矩形', () => {
    const rect: Rect = { x: 50, y: 0, width: 100, height: 200 };
    const hits = edgeRectIntersections(
      { x: 0, y: 100 },
      { x: 200, y: 100 },
      [{ x: 50, y: 100 }],
      rect,
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});

describe('P2.1 弯折点编辑纯函数', () => {
  const S = { x: 0, y: 50 };
  const T = { x: 200, y: 150 };

  it('insertBendPoint：空 points → 光标落在 source→target 段之间，得到单点', () => {
    const pts = insertBendPoint([], { x: 100, y: 100 }, S, T);
    expect(pts).toEqual([{ x: 100, y: 100 }]);
    // 路径几何随之变为带弯折的两段贝塞尔
    const d = buildEdgePath({ ...S, position: 'right' }, { ...T, position: 'left' }, pts);
    expect(d).toContain('100 100');
    expect(d.match(/C/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('insertBendPoint：已有两点时，光标落在 p0→p1 段 → 插入在两点之间（保序）', () => {
    const existing = [{ x: 60, y: 50 }, { x: 60, y: 150 }];
    // 光标在 p0(60,50)→p1(60,150) 竖直线中点
    const pts = insertBendPoint(existing, { x: 60, y: 100 }, S, T);
    expect(pts).toEqual([
      { x: 60, y: 50 },
      { x: 60, y: 100 },
      { x: 60, y: 150 },
    ]);
  });

  it('insertBendPoint：光标落在 pn→target 末段 → 追加到末尾', () => {
    const existing = [{ x: 60, y: 50 }];
    const pts = insertBendPoint(existing, { x: 150, y: 150 }, S, T);
    expect(pts.length).toBe(2);
    expect(pts[1]).toEqual({ x: 150, y: 150 });
  });

  it('insertBendPoint：不突变入参数组', () => {
    const existing = [{ x: 60, y: 50 }];
    const before = JSON.stringify(existing);
    insertBendPoint(existing, { x: 10, y: 10 }, S, T);
    expect(JSON.stringify(existing)).toBe(before);
  });

  it('removeBendPoint：删除指定下标，其余保序', () => {
    const pts = removeBendPoint([{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], 1);
    expect(pts).toEqual([{ x: 1, y: 1 }, { x: 3, y: 3 }]);
  });

  it('removeBendPoint：删空后路径回到纯贝塞尔', () => {
    const one = [{ x: 80, y: 80 }];
    const rest = removeBendPoint(one, 0);
    expect(rest).toEqual([]);
    expect(buildEdgePath({ ...S, position: 'right' }, { ...T, position: 'left' }, rest)).toBe(
      buildEdgePath({ ...S, position: 'right' }, { ...T, position: 'left' }, []),
    );
  });

  it('removeBendPoint：越界下标原样返回副本', () => {
    const pts = removeBendPoint([{ x: 1, y: 1 }], 5);
    expect(pts).toEqual([{ x: 1, y: 1 }]);
  });

  it('translateBendPoints：整体平移且不突变', () => {
    const pts = translateBendPoints([{ x: 0, y: 0 }, { x: 10, y: 20 }], 5, -3);
    expect(pts).toEqual([{ x: 5, y: -3 }, { x: 15, y: 17 }]);
  });

  it('distToSegment：垂足在线段上取垂距，外取端点', () => {
    // 垂点在线段上：(5,5) 到 x 轴段 (0,0)-(10,0) 的垂距为 5
    expect(distToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    // 垂点在线段外：(-5,3) 到段的最近点是端点 (0,0) → sqrt(34)
    expect(distToSegment({ x: -5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(Math.hypot(5, 3));
  });
});
