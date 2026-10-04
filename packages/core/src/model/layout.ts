/**
 * 布局偏好。
 * P0 仅 3 种树布局（d3-hierarchy 驱动）：
 *   - mindmap-right：思维导图横向，根在左，子树向右展开。
 *   - mindmap-down：思维导图纵向，根在上，子树向下展开。
 *   - org-tree：组织结构树（层级更扁，类似公司架构图）。
 * P1 预留字符串字面量 'radial'（放射树，未实现）。
 *
 * 【用户 override】不引入 dagre / d3-force / elkjs；'dag' / 'force' 等非树布局本期不存在。
 */
export type LayoutMode = 'mindmap-right' | 'mindmap-down' | 'org-tree' | 'radial';

/** P0 实际可用布局模式子集。 */
export const P0_LAYOUT_MODES = ['mindmap-right', 'mindmap-down', 'org-tree'] as const;

export interface LayoutPrefs {
  mode: LayoutMode;
  /** 层级（父子）间距 px。 */
  rankSpacing: number;
  /** 同级兄弟间距 px。 */
  nodeSpacing: number;
}
