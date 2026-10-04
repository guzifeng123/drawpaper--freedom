import * as React from 'react';
import { Tags, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PanelsApi } from './panels-api';

/**
 * 标签筛选条（Wave3-H §4.8）：
 * - 点标签 chip 切换选中（any/all 开关切换组合语义）；
 * - 清除筛选；
 * - 画布侧消费（见 docs/wave3/h-panels.md）：非匹配节点降透明度、隐藏连线。
 */
export const TagFilterBar = React.memo(function TagFilterBar({ api }: { api: PanelsApi }) {
  const { tagFilter } = api;
  const hasFilter =
    tagFilter.tagIds.length > 0 ||
    tagFilter.blockTypes.length > 0 ||
    tagFilter.colors.length > 0;

  const toggleTag = (id: string) => {
    const set = new Set(tagFilter.tagIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    api.setTagFilter({ tagIds: [...set] });
  };

  if (api.tags.length === 0 && !hasFilter) return null;

  return (
    <div className="absolute right-4 top-14 z-20 flex max-w-[60%] flex-wrap items-center gap-1.5 rounded-lg border bg-card/95 px-2 py-1.5 shadow-sm">
      <Tags className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {api.tags.map((t) => {
        const active = tagFilter.tagIds.includes(t.id);
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => toggleTag(t.id)}
            className={cn(
              'flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors',
              active
                ? 'border-transparent text-white'
                : 'border-border bg-transparent text-muted-foreground hover:text-foreground',
            )}
            style={active ? { backgroundColor: t.color } : undefined}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: active ? '#fff' : t.color }}
            />
            {t.name}
          </button>
        );
      })}
      {api.tags.length > 0 ? (
        <button
          type="button"
          className="ml-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
          onClick={() =>
            api.setTagFilter({ match: tagFilter.match === 'any' ? 'all' : 'any' })
          }
          title="切换组合语义：命中任一 / 必须全部"
        >
          {tagFilter.match === 'any' ? '任一' : '全部'}
        </button>
      ) : null}
      {hasFilter ? (
        <button
          type="button"
          onClick={() => api.clearTagFilter()}
          className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-destructive"
        >
          <X className="h-3 w-3" /> 清除
        </button>
      ) : null}
    </div>
  );
});
