/**
 * geometry.ts —— 拖拽对齐参考线 / 网格磁吸的纯几何计算。
 * canvas 拖拽时调用：返回吸附后的位移 + 要绘制的参考线。
 */

export interface Rect {
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GuideLine {
  orientation: 'vertical' | 'horizontal';
  /** 世界坐标（x 或 y）。 */
  pos: number;
}

export interface SnapResult {
  /** 吸附后的位移（加到拖拽 delta 上）。 */
  dx: number;
  dy: number;
  /** 本次命中的参考线（渲染用）。 */
  lines: GuideLine[];
}

const THRESHOLD = 6;

/** 收集矩形的三条参考线位置（左 / 中 / 右 或 上 / 中 / 下）。 */
function vLines(r: Rect): [number, number, number] {
  return [r.x, r.x + r.width / 2, r.x + r.width];
}
function hLines(r: Rect): [number, number, number] {
  return [r.y, r.y + r.height / 2, r.y + r.height];
}

/**
 * 计算吸附。moving 是「当前拖拽中的矩形」（未吸附坐标），others 是静止矩形。
 * 网格磁吸：prefs.gridSnap 开启时整体对齐到 gridSize。
 */
export function computeSnap(moving: Rect, others: Rect[], opts?: { threshold?: number; grid?: number; gridSnap?: boolean }): SnapResult {
  const threshold = opts?.threshold ?? THRESHOLD;
  const grid = opts?.grid ?? 20;

  let bestDx = 0;
  let bestDy = 0;
  const lines: GuideLine[] = [];

  const myV = vLines(moving);
  let bestVDiff = threshold + 1;
  let bestVPos: number | null = null;
  for (const o of others) {
    for (const target of vLines(o)) {
      for (const mine of myV) {
        const diff = target - mine;
        if (Math.abs(diff) < Math.abs(bestVDiff)) {
          bestVDiff = diff;
          bestVPos = target;
        }
      }
    }
  }
  if (bestVPos !== null && Math.abs(bestVDiff) <= threshold) {
    bestDx = bestVDiff;
    lines.push({ orientation: 'vertical', pos: bestVPos });
  }

  const myH = hLines(moving);
  let bestHDiff = threshold + 1;
  let bestHPos: number | null = null;
  for (const o of others) {
    for (const target of hLines(o)) {
      for (const mine of myH) {
        const diff = target - mine;
        if (Math.abs(diff) < Math.abs(bestHDiff)) {
          bestHDiff = diff;
          bestHPos = target;
        }
      }
    }
  }
  if (bestHPos !== null && Math.abs(bestHDiff) <= threshold) {
    bestDy = bestHDiff;
    lines.push({ orientation: 'horizontal', pos: bestHPos });
  }

  if (opts?.gridSnap) {
    const gx = Math.round((moving.x + bestDx) / grid) * grid - (moving.x + bestDx);
    const gy = Math.round((moving.y + bestDy) / grid) * grid - (moving.y + bestDy);
    if (Math.abs(gx) <= threshold) bestDx += gx;
    if (Math.abs(gy) <= threshold) bestDy += gy;
  }

  return { dx: bestDx, dy: bestDy, lines };
}
