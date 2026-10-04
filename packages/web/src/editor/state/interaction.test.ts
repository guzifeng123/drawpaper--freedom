import { describe, it, expect } from 'vitest';
import { initialInteraction, reduceInteraction } from './interaction';

describe('interaction 状态机', () => {
  it('初始为 select/未编辑', () => {
    const s = initialInteraction();
    expect(s.kind).toBe('select');
    expect(s.editing).toBe(false);
  });

  it('工具切换', () => {
    let s = initialInteraction();
    s = reduceInteraction(s, { type: 'tool-connect' }).next;
    expect(s.kind).toBe('connect');
    s = reduceInteraction(s, { type: 'tool-pan' }).next;
    expect(s.kind).toBe('pan');
    s = reduceInteraction(s, { type: 'tool-select' }).next;
    expect(s.kind).toBe('select');
  });

  it('Esc 分层：编辑中先退出编辑仍选中', () => {
    let s = initialInteraction();
    s = reduceInteraction(s, { type: 'enter-edit' }).next;
    expect(s.editing).toBe(true);
    const r = reduceInteraction(s, { type: 'esc' });
    expect(r.next.editing).toBe(false);
    expect(r.next.kind).toBe('select');
    expect(r.clearSelection).toBe(false);
  });

  it('Esc：连线/框选进行中回 select，不清选择', () => {
    let s = initialInteraction();
    s = reduceInteraction(s, { type: 'start-connect' }).next;
    expect(s.kind).toBe('connect');
    const r = reduceInteraction(s, { type: 'esc' });
    expect(r.next.kind).toBe('select');
    expect(r.clearSelection).toBe(false);
  });

  it('Esc：select 层第二次 Esc 清空选择', () => {
    let s = initialInteraction();
    s = reduceInteraction(s, { type: 'start-box-select' }).next;
    s = reduceInteraction(s, { type: 'esc' }).next; // 回 select
    const r = reduceInteraction(s, { type: 'esc' });
    expect(r.next.kind).toBe('select');
    expect(r.clearSelection).toBe(true);
  });

  it('commit 后回到 select', () => {
    let s = initialInteraction();
    s = reduceInteraction(s, { type: 'start-insert' }).next;
    s = reduceInteraction(s, { type: 'commit' }).next;
    expect(s.kind).toBe('select');
  });
});
