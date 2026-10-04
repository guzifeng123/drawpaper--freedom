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

/** 页眉色带高度 px（预留，渲染层在内容区顶部绘制）。 */
export const HEADER_BAND_PX = 24;
/** 页脚色带高度 px（预留）。 */
export const FOOTER_BAND_PX = 24;

/** flow 模式每加深一级的缩进 px。 */
export const FLOW_INDENT_PER_LEVEL = 28;
/** flow 模式相邻块之间的纵向间隙 px。 */
export const FLOW_BLOCK_GAP_PX = 8;

/** A4 整页像素尺寸（按方向）。 */
export function pagePixelSize(orientation: 'portrait' | 'landscape'): { width: number; height: number } {
  return orientation === 'portrait' ? A4_PORTRAIT_PX : A4_LANDSCAPE_PX;
}

/** contentRect 入参形状（避免与 model.PageSettings 强耦合）。 */
export interface ContentRectSettings {
  orientation: 'portrait' | 'landscape';
  marginMm: number;
  /** 是否绘制页眉色带（预留顶部 24px）。 */
  header?: boolean;
  /** 是否绘制页脚色带（预留底部 24px）。 */
  footer?: boolean;
}

/** 页内容区矩形（页面尺寸减去四边 margin，并扣除页眉/页脚色带）。 */
export function contentRect(settings: ContentRectSettings): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const page = pagePixelSize(settings.orientation);
  const m = mmToPx(settings.marginMm);
  const headerH = settings.header ? HEADER_BAND_PX : 0;
  const footerH = settings.footer ? FOOTER_BAND_PX : 0;
  return {
    x: m,
    y: m + headerH,
    width: page.width - m * 2,
    height: page.height - m * 2 - headerH - footerH,
  };
}
