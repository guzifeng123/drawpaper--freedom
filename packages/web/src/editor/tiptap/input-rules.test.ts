import { describe, it, expect } from 'vitest';
import { matchMarkdownRule } from './input-rules';
import { filterSlashItems } from './slash-menu';

describe('Markdown 行首快捷规则', () => {
  it.each([
    ['# ', 'h1'],
    ['## ', 'h2'],
    ['### ', 'h3'],
    ['- ', 'bullet'],
    ['* ', 'bullet'],
    ['1. ', 'ordered'],
    ['[] ', 'todo'],
    ['[ ] ', 'todo'],
    ['[x] ', 'todo'],
    ['> ', 'quote'],
    ['--- ', 'hr'],
  ])('%s → %s', (input, expected) => {
    expect(matchMarkdownRule(input)).toBe(expected);
  });

  it('非行首/不匹配返回 null', () => {
    expect(matchMarkdownRule('hello # ')).toBeNull();
    expect(matchMarkdownRule('# 标题')).toBeNull();
    expect(matchMarkdownRule('-abc')).toBeNull();
  });
});

describe('斜杠菜单过滤', () => {
  it('空 query 返回全部', () => {
    expect(filterSlashItems('').length).toBeGreaterThan(10);
  });
  it('按中文标签过滤', () => {
    const r = filterSlashItems('标题');
    expect(r.length).toBe(3);
    expect(r.map((i) => i.id).sort()).toEqual(['h1', 'h2', 'h3']);
  });
  it('按 id 过滤（英文）', () => {
    expect(filterSlashItems('todo').map((i) => i.id)).toEqual(['todo']);
  });
});
