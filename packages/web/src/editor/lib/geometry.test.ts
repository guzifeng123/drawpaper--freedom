import { describe, it, expect } from 'vitest';
import { computeSnap } from './geometry';

describe('geometry 磁吸 / 参考线', () => {
  it('对齐到其他节点的左边线（阈值内）', () => {
    const moving = { id: 'a', x: 100, y: 50, width: 100, height: 40 };
    const others = [{ id: 'b', x: 200, y: 50, width: 100, height: 40 }];
    // moving 右缘 200 对齐 others 左边 200 → dx=0；无位移差异时不命中
    const r = computeSnap(moving, others);
    expect(r.dx).toBe(0);
  });

  it('偏 4px 时吸附到对齐线', () => {
    const moving = { id: 'a', x: 196, y: 50, width: 100, height: 40 }; // 右缘 296
    const others = [{ id: 'b', x: 300, y: 50, width: 100, height: 40 }]; // 左缘 300
    const r = computeSnap(moving, others);
    expect(r.dx).toBe(4);
    expect(r.lines.some((l) => l.orientation === 'vertical' && l.pos === 300)).toBe(true);
  });

  it('超过阈值不吸附', () => {
    const moving = { id: 'a', x: 180, y: 50, width: 100, height: 40 }; // 右缘 280
    const others = [{ id: 'b', x: 300, y: 50, width: 100, height: 40 }];
    const r = computeSnap(moving, others);
    expect(Math.abs(r.dx)).toBeLessThanOrEqual(6);
    expect(r.dx).not.toBe(20);
  });

  it('水平线吸附（中线对齐）', () => {
    const moving = { id: 'a', x: 0, y: 96, width: 100, height: 40 }; // 中 y=116
    const others = [{ id: 'b', x: 0, y: 100, width: 100, height: 40 }]; // 中 y=120
    const r = computeSnap(moving, others);
    expect(r.dy).toBe(4);
    expect(r.lines.some((l) => l.orientation === 'horizontal')).toBe(true);
  });

  it('网格磁吸开启时对齐到 grid', () => {
    const moving = { id: 'a', x: 14, y: 0, width: 100, height: 40 };
    const r = computeSnap(moving, [], { gridSnap: true, grid: 20 });
    expect(r.dx).toBe(6); // 14 → 20（|6| <= 阈值）
  });
});
