import { describe, expect, it } from 'vitest';
import { nodeMatchesFilter, collectFilteredNodes, EMPTY_TAG_FILTER } from './filter-match';

describe('nodeMatchesFilter', () => {
  it('空筛选命中全部', () => {
    expect(nodeMatchesFilter([], EMPTY_TAG_FILTER)).toBe(true);
    expect(nodeMatchesFilter(['a'], { mode: 'any', tagIds: [] })).toBe(true);
  });

  it('any 模式：任意交集即命中', () => {
    expect(nodeMatchesFilter(['x', 'y'], { mode: 'any', tagIds: ['y', 'z'] })).toBe(true);
    expect(nodeMatchesFilter(['x'], { mode: 'any', tagIds: ['y', 'z'] })).toBe(false);
  });

  it('all 模式：所有筛选标签都要出现', () => {
    expect(nodeMatchesFilter(['a', 'b', 'c'], { mode: 'all', tagIds: ['a', 'c'] })).toBe(true);
    expect(nodeMatchesFilter(['a', 'b'], { mode: 'all', tagIds: ['a', 'c'] })).toBe(false);
  });
});

describe('collectFilteredNodes', () => {
  it('批量按 any 过滤', () => {
    const map = new Map<string, string[]>([
      ['n1', ['a']],
      ['n2', ['b']],
      ['n3', ['a', 'b']],
    ]);
    const hit = collectFilteredNodes(map, { mode: 'any', tagIds: ['b'] });
    expect(hit.has('n2')).toBe(true);
    expect(hit.has('n3')).toBe(true);
    expect(hit.has('n1')).toBe(false);
  });

  it('空筛选返回全部', () => {
    const map = new Map<string, string[]>([['n1', ['a']], ['n2', []]]);
    expect(collectFilteredNodes(map, EMPTY_TAG_FILTER).size).toBe(2);
  });
});
