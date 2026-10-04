/**
 * 边（父子连线）颜色样本。
 *
 * 【样本色】当前提供 5 种淡色系 + 1 种默认中性灰，集中在此常量便于日后整体替换
 * （例如未来做主题色、用户自定义配色时，只改这一处即可全局生效）。
 * 注意：P0 不做直线/折线/贝塞尔切换、不做虚实线切换（贝塞尔曲线为默认渲染）。
 */

export interface EdgeColorDef {
  /** 机器稳定 key（持久化到 edge.style.color 用 hex，此处 key 仅用于 UI 枚举）。 */
  key: string;
  /** 中文展示名。 */
  name: string;
  /** 十六进制颜色值（默认即落库值）。 */
  hex: string;
}

/** 5 种淡色系样本边色。 */
export const EDGE_COLORS: readonly EdgeColorDef[] = [
  { key: 'blue', name: '淡蓝', hex: '#93C5FD' },
  { key: 'green', name: '淡绿', hex: '#86EFAC' },
  { key: 'yellow', name: '淡黄', hex: '#FCD34D' },
  { key: 'purple', name: '淡紫', hex: '#D8B4FE' },
  { key: 'pink', name: '淡粉', hex: '#F9A8D4' },
] as const;

/** 新建边时的默认中性灰。 */
export const DEFAULT_EDGE_COLOR: EdgeColorDef = {
  key: 'neutral',
  name: '中性灰',
  hex: '#94A3B8',
} as const;

/** 所有合法边色 hex 集合（含默认色），供校验使用。 */
export const ALL_EDGE_COLORS: readonly string[] = [
  ...EDGE_COLORS.map((c) => c.hex),
  DEFAULT_EDGE_COLOR.hex,
] as const;
