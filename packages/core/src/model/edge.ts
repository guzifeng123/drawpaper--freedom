import type { HandlePosition } from './constants.js';

/**
 * 边 = 有向父子连线（带实心箭头）。
 *
 * 【用户 override】P0 只有父子关系一种语义：
 *   - 不存在 relation / line / direction / points 等字段（文档 §5 的 7 种关系枚举已废弃）。
 *   - 边直接构成主树（source = 父，target = 子）。
 *   - 不做关系类型浮层、1–n 键盘选关系、关系图例/过滤。
 *   - 直线/折线/贝塞尔、虚实线切换 P0 不做（默认贝塞尔）。
 * 边可带自由文字标签。
 */
export interface Edge {
  id: string;

  /** 父块 id（有向边起点，箭头由此指向 target）。 */
  source: string;
  /** 子块 id（有向边终点）。 */
  target: string;

  /** 端点句柄位置（缺省由渲染层给默认值，如 right/left）。 */
  sourceHandle: HandlePosition;
  targetHandle: HandlePosition;

  /** 自由文字标签（可空串）。 */
  label: string;

  /** 恒为 true：边一律有向（父子方向）。 */
  directed: true;

  style: {
    /** 边色 hex，取 EDGE_COLORS / DEFAULT_EDGE_COLOR 之一；允许任意合法 hex 以便未来扩展。 */
    color: string;
  };
}
