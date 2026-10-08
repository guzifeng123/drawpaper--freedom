/**
 * edge-crossing.ts —— 弯折边（edge.points）跨页续接的纯几何（零 DOM）。
 *
 * 一条边的世界路径 = source 锚点 → edge.points（世界坐标）→ target 锚点 的折线。
 * 对相邻顶点段：两端点各属一页；同页 → 该页整段绘制；异页 → 相邻两页成对发
 * ContinuationMarker（token 按段编号 cont:<edgeId>:<seg>，peerPageIndex 互指）。
 * 无 points 的边不走这里（保持原端点 clamp 行为，回归保护）。
 */

export interface Pt {
  x: number;
  y: number;
}

export interface PageRect {
  index: number;
  worldRect: { x: number; y: number; width: number; height: number };
}

/** 点落在哪个页矩形内（含重叠带）；返回页 index。 */
export function pageContainingPoint(p: Pt, pages: PageRect[]): number | null {
  for (const pg of pages) {
    const r = pg.worldRect;
    if (p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height) return pg.index;
  }
  return null;
}

/** 离某点最近的页（兜底：点落在页间缝隙时）。 */
export function nearestPage(p: Pt, pages: PageRect[]): number {
  let best = pages[0]!.index;
  let bestD = Infinity;
  for (const pg of pages) {
    const r = pg.worldRect;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = pg.index;
    }
  }
  return best;
}

export interface SegmentPair {
  /** 段序号（用于 token）。 */
  seg: number;
  /** 段起点所在页。 */
  pageA: number;
  /** 段终点所在页。 */
  pageB: number;
  /** 起点世界坐标（落点）。 */
  pointA: Pt;
  /** 终点世界坐标（落点）。 */
  pointB: Pt;
  /**
   * 边在跨页处的「前进方向」（世界坐标，已归一化；翻译/缩放不改变其朝向）。
   * pageA 侧为出页方向（朝 peer），pageB 侧为入页方向（朝本页内）；
   * 两侧共享同一方向向量——即同一逻辑边在切页边界的切线方向。
   */
  dir: Pt;
}

/** 单位化方向向量；零向量兜底为 (1,0)，保证角度有限。 */
export function unitDir(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: 1, y: 0 };
  return { x: dx / len, y: dy / len };
}

/** 方向向量 → 页面本地 SVG 角度（弧度，y 轴向下；0 = +x，顺时针为正）。 */
export function dirToAngle(dir: Pt): number {
  return Math.atan2(dir.y, dir.x);
}

/**
 * 把顶点折线拆成「逐页段」：同页段标记 samePage（edgeId 压入该页），
 * 跨页段返回成对 marker 信息。
 */
export function planBentEdgeSegments(
  vertices: Pt[],
  pages: PageRect[],
): { samePageEdges: number[]; crossPairs: SegmentPair[] } {
  const samePageEdges: number[] = [];
  const crossPairs: SegmentPair[] = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i]!;
    const b = vertices[i + 1]!;
    const pa = pageContainingPoint(a, pages) ?? nearestPage(a, pages);
    const pb = pageContainingPoint(b, pages) ?? nearestPage(b, pages);
    if (pa === pb) {
      samePageEdges.push(pa);
    } else {
      crossPairs.push({
        seg: i,
        pageA: pa,
        pageB: pb,
        pointA: a,
        pointB: b,
        dir: unitDir(a, b),
      });
    }
  }
  return { samePageEdges, crossPairs };
}
