/**
 * 物理常量与单位换算。
 * A4 = 210 × 297 mm；96 dpi 下纵向 794 × 1123 px / 横向 1123 × 794 px。
 */

/** A4 短边 mm。 */
export const A4_WIDTH_MM = 210;
/** A4 长边 mm。 */
export const A4_HEIGHT_MM = 297;

/** CSS 参考 dpi（px ↔ mm 换算基准）。 */
export const CSS_DPI = 96;

/** mm → px（CSS px）。 */
export function mmToPx(mm: number): number {
  return (mm / 25.4) * CSS_DPI;
}

/** px → mm。 */
export function pxToMm(px: number): number {
  return (px * 25.4) / CSS_DPI;
}

/** 96dpi 下 A4 纵向整页尺寸（含页边距前的纸张物理尺寸）。 */
export const A4_PORTRAIT_PX = {
  width: mmToPx(A4_WIDTH_MM), // ≈ 794
  height: mmToPx(A4_HEIGHT_MM), // ≈ 1123
} as const;

/** 96dpi 下 A4 横向整页尺寸。 */
export const A4_LANDSCAPE_PX = {
  width: mmToPx(A4_HEIGHT_MM), // ≈ 1123
  height: mmToPx(A4_WIDTH_MM), // ≈ 794
} as const;

/** tiles 模式相邻页重叠带宽度 mm（产品约定 10mm）。 */
export const TILES_OVERLAP_MM = 10;
