/**
 * A4 导出分页设置。
 */

export type PageOrientation = 'portrait' | 'landscape';
export type PageMarginMm = 10 | 15 | 20;
export type PageColorMode = 'color' | 'gray';

/** 三种分页排版模式（见 paginate 模块）。 */
export type PageMode =
  | 'fit' // 适应一页：等比缩放铺满单页
  | 'tiles' // 画布分页：保留空间布局，A4 网格切页，10mm 重叠带
  | 'flow'; // 文档重排：树按深度转打印流，块零切割

/** 手动分页符锚点（世界坐标 y 或 x，flow/tiles 模式用）。 */
export interface PageBreak {
  /** 在该世界坐标处强制断页（纵向流用 y；横向平铺用 x）。 */
  at: number;
}

export interface PageSettings {
  size: 'A4';
  orientation: PageOrientation;
  marginMm: PageMarginMm;
  mode: PageMode;
  /** 画布上是否叠加显示 A4 分页虚线。 */
  showPageBreak: boolean;
  colorMode: PageColorMode;
  /** 页眉/页脚/页码显隐。 */
  header: boolean;
  footer: boolean;
  showPageNumbers: boolean;
  /** 用户手动插入的分页符。 */
  pageBreaks: PageBreak[];
  /**
   * 分页原点（世界坐标偏移，px）。默认由内容包围盒推导；
   * 用户可在分页预览中整体拖动分页原点。
   */
  pageOrigin?: { x: number; y: number };
}
