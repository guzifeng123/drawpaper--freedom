import { describe, it, expect } from 'vitest';
import type { BlockNode, Tag } from '@drawpaper/core';
import { nodeMatchesFilter } from './tag-filter';
import type { TagFilterState } from '../panels-api';

function node(over: Partial<BlockNode>): BlockNode {
  return {
    id: 'n1',
    type: 'text',
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    content: { format: 'tiptap-json', data: {} },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
    ...over,
  };
}

const TAGS: Tag[] = [
  { id: 't1', name: 'A', color: '#000' },
  { id: 't2', name: 'B', color: '#111' },
];

const EMPTY: TagFilterState = { tagIds: [], blockTypes: [], colors: [], match: 'any' };

describe('tag-filter', () => {
  it('空筛选全部通过', () => {
    expect(nodeMatchesFilter(node({}), TAGS, EMPTY)).toBe(true);
  });

  it('标签 any：命中其一即过', () => {
    const f: TagFilterState = { ...EMPTY, tagIds: ['t1', 't2'], match: 'any' };
    expect(nodeMatchesFilter(node({ tags: ['t1'] }), TAGS, f)).toBe(true);
    expect(nodeMatchesFilter(node({ tags: ['t2'] }), TAGS, f)).toBe(true);
    expect(nodeMatchesFilter(node({ tags: [] }), TAGS, f)).toBe(false);
  });

  it('标签 all：必须全部持有', () => {
    const f: TagFilterState = { ...EMPTY, tagIds: ['t1', 't2'], match: 'all' };
    expect(nodeMatchesFilter(node({ tags: ['t1', 't2'] }), TAGS, f)).toBe(true);
    expect(nodeMatchesFilter(node({ tags: ['t1'] }), TAGS, f)).toBe(false);
  });

  it('块类型筛选', () => {
    const f: TagFilterState = { ...EMPTY, blockTypes: ['heading'] };
    expect(nodeMatchesFilter(node({ type: 'heading' }), TAGS, f)).toBe(true);
    expect(nodeMatchesFilter(node({ type: 'text' }), TAGS, f)).toBe(false);
  });

  it('颜色筛选：bg 精确匹配（大小写不敏感）', () => {
    const f: TagFilterState = { ...EMPTY, colors: ['#ff0000'] };
    expect(nodeMatchesFilter(node({ style: { bg: '#FF0000' } }), TAGS, f)).toBe(true);
    expect(nodeMatchesFilter(node({ style: { bg: '#00ff00' } }), TAGS, f)).toBe(false);
    expect(nodeMatchesFilter(node({ style: {} }), TAGS, f)).toBe(false);
  });

  it('多维度 AND：标签过但类型不过 → 拒', () => {
    const f: TagFilterState = { ...EMPTY, tagIds: ['t1'], blockTypes: ['heading'] };
    expect(nodeMatchesFilter(node({ tags: ['t1'], type: 'text' }), TAGS, f)).toBe(false);
    expect(nodeMatchesFilter(node({ tags: ['t1'], type: 'heading' }), TAGS, f)).toBe(true);
  });
});
