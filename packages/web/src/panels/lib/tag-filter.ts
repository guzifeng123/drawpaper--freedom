import type { BlockNode, Tag } from '@drawpaper/core';
import type { TagFilterState } from '../panels-api';

/**
 * 标签筛选纯逻辑（零 DOM，可单测）。
 *
 * 约定：
 * - 空筛选（tagIds / blockTypes / colors 全空）→ 全部节点过；
 * - 三个维度之间是 AND；
 * - 标签维度内部按 match 决定 any（命中其一即过）/ all（须全部持有）；
 * - 颜色按节点 style.bg 精确匹配（hex 大小写不敏感；命名色由渲染层映射后也应落到同一集合）。
 *
 * 画布侧消费（见 docs/wave3/h-panels.md）：
 * - 不匹配节点降透明度（opacity ≈ 0.35）、其连线隐藏；
 * - 匹配节点正常显示。
 */

/** 节点是否通过筛选。 */
export function nodeMatchesFilter(
  node: BlockNode,
  tags: Tag[],
  filter: TagFilterState,
): boolean {
  const noTagFilter = filter.tagIds.length === 0;
  const noTypeFilter = filter.blockTypes.length === 0;
  const noColorFilter = filter.colors.length === 0;
  if (noTagFilter && noTypeFilter && noColorFilter) return true;

  // 维度一：标签
  if (!noTagFilter) {
    const owned = new Set(node.tags);
    const hits = filter.tagIds.filter((id) => owned.has(id));
    const pass =
      filter.match === 'all'
        ? filter.tagIds.every((id) => owned.has(id))
        : hits.length > 0;
    if (!pass) return false;
  }

  // 维度二：块类型
  if (!noTypeFilter && !filter.blockTypes.includes(node.type)) return false;

  // 维度三：节点颜色
  if (!noColorFilter) {
    const bg = (node.style.bg ?? '').toLowerCase();
    if (!bg || !filter.colors.some((c) => c.toLowerCase() === bg)) return false;
  }

  void tags;
  return true;
}

/** 节点的标签名展示（供 TagFilterBar 按钮文案用）。 */
export function tagNamesOf(node: BlockNode, tags: Tag[]): string[] {
  const byId = new Map(tags.map((t) => [t.id, t.name]));
  return node.tags.map((id) => byId.get(id) ?? id);
}

/** 8 色板（标签/块共用，与编辑器 hover 工具条一致）。 */
export const TAG_SWATCHES: readonly string[] = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
] as const;
