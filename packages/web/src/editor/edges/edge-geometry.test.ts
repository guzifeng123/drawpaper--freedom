import { describe, expect, it } from 'vitest';
import {
  buildEdgePath,
  edgeMidpoint,
  edgeRectIntersections,
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
