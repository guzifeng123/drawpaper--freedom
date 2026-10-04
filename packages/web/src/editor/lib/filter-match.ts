/**
 * filter-match.ts —— 标签/类型筛选的纯函数匹配（与面板 agent 的 any/all 语义一致）。
 *
 * 语义约定（供面板/画布对齐）：
 * - 空筛选（tagIds 为空）→ 命中全部节点（不筛选）。
 * - mode='any'：节点标签与筛选标签集合有任意交集即命中。
 * - mode='all'：筛选标签集合中的每一个都出现在节点标签中才命中。
 */

export type TagFilterMode = 'any' | 'all';

export interface TagFilter {
  mode: TagFilterMode;
  /** 被筛选的 tag id 列表。 */
  tagIds: string[];
}

export const EMPTY_TAG_FILTER: TagFilter = { mode: 'any', tagIds: [] };

/**
 * 判断一个节点的标签集合是否通过筛选。
 * @param nodeTags 节点拥有的 tag id 列表（BlockNode.tags）。
 * @param filter   筛选条件。
 */
export function nodeMatchesFilter(nodeTags: readonly string[], filter: TagFilter): boolean {
  if (!filter.tagIds.length) return true;
  const set = new Set(nodeTags);
  if (filter.mode === 'any') {
    return filter.tagIds.some((t) => set.has(t));
  }
  // all：每个筛选标签都必须在节点上
  return filter.tagIds.every((t) => set.has(t));
}

/**
 * 批量计算命中集合（画布一次性消费）。
 * @param nodeTagsById  nodeId → 其 tag id 列表。
 * @param filter        筛选条件。
 * @returns 命中的 nodeId 集合。
 */
export function collectFilteredNodes(
  nodeTagsById: ReadonlyMap<string, readonly string[]>,
  filter: TagFilter,
): Set<string> {
  const out = new Set<string>();
  for (const [id, tags] of nodeTagsById) {
    if (nodeMatchesFilter(tags, filter)) out.add(id);
  }
  return out;
}
