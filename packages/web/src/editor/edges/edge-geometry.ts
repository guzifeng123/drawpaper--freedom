import type { HandlePosition } from '@drawpaper/core';

/**
 * edge-geometry.ts —— 边路径几何纯函数（无 DOM、无 RF 实例）。
 *
 * 画布 ParentEdge、SVG 导出、PrintSheets 离屏渲染共用同一套几何，
 * 保证弯折边在三处一致。
 *
 * - 无 points / 空数组：三次贝塞尔（端点处水平/垂直平滑，随句柄朝向）。
 * - 有 points：source →[平滑入]→ 逐点折线 →[平滑入]→ target；箭头仍在 target。
 */

export interface EdgeEnd {
  x: number;
  y: number;
  position: HandlePosition;
}

/** 由句柄朝向给出该端的贝塞尔出/入切向量方向（长度 0..1）。 */
function outDir(pos: HandlePosition): { x: number; y: number } {
  switch (pos) {
    case 'right':
      return { x: 1, y: 0 };
    case 'left':
      return { x: -1, y: 0 };
    case 'top':
      return { x: 0, y: -1 };
    case 'bottom':
      return { x: 0, y: 1 };
  }
}

/** 两端点之间的贝塞尔控制点偏移量（与 RF getBezierPath 视觉一致的量级）。 */
function controlOffset(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  return Math.max(40, (Math.max(dx, dy) * 2) / 3);
}

/**
 * 生成 SVG path `d`。
 * - points 为空：`M a C c1 c2 b`
 * - points 非空：`M a C->p0  L p1..pn  C->b`（首末段用贝塞尔平滑，中间为折线）
 */
export function buildEdgePath(source: EdgeEnd, target: EdgeEnd, points?: ReadonlyArray<{ x: number; y: number }>): string {
  const sp = { x: source.x, y: source.y };
  const tp = { x: target.x, y: target.y };
  const pts = (points ?? []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

  if (pts.length === 0) {
    const off = controlOffset(source, target);
    const da = outDir(source.position);
    const db = outDir(target.position);
    const c1 = { x: sp.x + da.x * off, y: sp.y + da.y * off };
    const c2 = { x: tp.x - db.x * off, y: tp.y - db.y * off };
    return `M ${sp.x} ${sp.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${tp.x} ${tp.y}`;
  }

  // 起点 → 第一个弯折点：贝塞尔平滑
  const p0 = pts[0]!;
  const offA = controlOffset(source, p0);
  const da = outDir(source.position);
  const c1 = { x: sp.x + da.x * offA, y: sp.y + da.y * offA };
  const cMid = { x: p0.x - da.x * offA * 0.4, y: p0.y - da.y * offA * 0.4 };
  let d = `M ${sp.x} ${sp.y} C ${c1.x} ${c1.y}, ${cMid.x} ${cMid.y}, ${p0.x} ${p0.y}`;

  // 中间弯折点：折线
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i]!.x} ${pts[i]!.y}`;
  }

  // 最后一个弯折点 → 终点：贝塞尔平滑
  const pn = pts[pts.length - 1]!;
  const offB = controlOffset(pn, target);
  const db = outDir(target.position);
  const cn = { x: pn.x + db.x * offB * 0.4, y: pn.y + db.y * offB * 0.4 };
  const c2 = { x: tp.x - db.x * offB, y: tp.y - db.y * offB };
  d += ` C ${cn.x} ${cn.y}, ${c2.x} ${c2.y}, ${tp.x} ${tp.y}`;
  return d;
}

/**
 * 边的「中点」（拖拽手柄落点）：
 * - 无 points：贝塞尔中点（近似，用于第一次拖出弯折点）。
 * - 有 points：取已有的第一个弯折点之前的贝塞尔段中点（便于继续加）。
 * 实际交互中新增弯折点落在用户拖到的位置；这里给一个稳定缺省。
 */
export function edgeMidpoint(source: EdgeEnd, target: EdgeEnd): { x: number; y: number } {
  return { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
}

/**
 * 线段与矩形的交点（用于跨页续接：折线各段与页内容矩形求交）。
 * 返回落在矩形边界上的交点列表（可能 0/1/2 个）。
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function segIntersectsRect(p1: { x: number; y: number }, p2: { x: number; y: number }, r: Rect): { x: number; y: number }[] {
  const edges: [ { x: number; y: number }, { x: number; y: number } ][] = [
    [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }],
    [{ x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }],
    [{ x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }],
    [{ x: r.x, y: r.y + r.height }, { x: r.x, y: r.y }],
  ];
  const out: { x: number; y: number }[] = [];
  for (const [a, b] of edges) {
    const hit = segSeg(p1, p2, a, b);
    if (hit) out.push(hit);
  }
  return out;
}

function segSeg(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  p4: { x: number; y: number },
): { x: number; y: number } | null {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

/**
 * 计算折线（source → points → target）与页矩形的交点。
 * 用于跨页弯折边续接标记：按真实折线穿越位置放置，而非端点归类。
 * 无 points 时退化为直线 source→target。
 */
export function edgeRectIntersections(
  source: { x: number; y: number },
  target: { x: number; y: number },
  points: ReadonlyArray<{ x: number; y: number }> | undefined,
  rect: Rect,
): { x: number; y: number }[] {
  const pts = [source, ...(points ?? []), target];
  const hits: { x: number; y: number }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    for (const h of segIntersectsRect(pts[i]!, pts[i + 1]!, rect)) hits.push(h);
  }
  return hits;
}
