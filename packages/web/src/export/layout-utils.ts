/**
 * 打印页几何纯函数（A4 px / 内容区 / 页眉页脚布局）。
 * 常量直接引用 core paginate 的真实导出（纯常量，不抛错）。
 */
import {
  A4_LANDSCAPE_PX,
  A4_PORTRAIT_PX,
  mmToPx,
  type PageOrientation,
} from '@drawpaper/core';

export interface SizePx {
  width: number;
  height: number;
}

/** 整页 A4 px 尺寸（96dpi 参考）。 */
export function sheetSizePx(orientation: PageOrientation): SizePx {
  return orientation === 'portrait' ? { ...A4_PORTRAIT_PX } : { ...A4_LANDSCAPE_PX };
}

/** 内容区尺寸 = 整页宽高 − 2×页边距。 */
export function contentSizePx(orientation: PageOrientation, marginMm: number): SizePx {
  const sheet = sheetSizePx(orientation);
  const m = mmToPx(marginMm);
  return { width: sheet.width - 2 * m, height: sheet.height - 2 * m };
}

/** 默认导出选项。 */
export const DEFAULT_EXPORT_OPTIONS = {
  orientation: 'portrait' as PageOrientation,
  marginMm: 15,
  mode: 'tiles',
  header: true,
  footer: true,
  showPageNumbers: true,
  edgeLabels: true,
  colorMode: 'color',
  scope: 'all',
  showPageBreak: false,
} as const;

/** 页码文案：「第 n / N 页」。 */
export function pageNumberLabel(index: number, total: number): string {
  return `第 ${index + 1} / ${total} 页`;
}
