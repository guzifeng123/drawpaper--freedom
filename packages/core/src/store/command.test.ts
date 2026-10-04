import { describe, it, expect, vi } from 'vitest';
import { createCommandStack } from './command.js';
import type { KBNoteDoc } from '../model/index.js';

function docWithTitle(title: string): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: 1,
    id: 'd1',
    title,
    board: { createdAt: 0, updatedAt: 0 },
    nodes: [],
    edges: [],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: {
      size: 'A4',
      orientation: 'portrait',
      marginMm: 15,
      mode: 'fit',
      showPageBreak: true,
      colorMode: 'color',
      header: false,
      footer: false,
      showPageNumbers: false,
      pageBreaks: [],
    },
    assetRefs: [],
  };
}

describe('createCommandStack', () => {
  it('push executes and undo/redo round-trip', () => {
    const stack = createCommandStack(docWithTitle('a'));
    expect(stack.canUndo()).toBe(false);
    const next = stack.push({
      name: 'rename',
      execute: (d) => ({ ...d, title: 'b' }),
      undo: (d) => ({ ...d, title: 'a' }),
    });
    expect(next.title).toBe('b');
    expect(stack.canUndo()).toBe(true);
    expect(stack.depth()).toEqual({ undo: 1, redo: 0 });

    const undone = stack.undo();
    expect(undone?.title).toBe('a');
    expect(stack.canRedo()).toBe(true);

    const redone = stack.redo();
    expect(redone?.title).toBe('b');
    expect(stack.depth()).toEqual({ undo: 1, redo: 0 });
  });

  it('new push clears redo stack', () => {
    const stack = createCommandStack(docWithTitle('a'));
    stack.push({ name: 'c1', execute: (d) => ({ ...d, title: 'x' }), undo: (d) => ({ ...d, title: 'a' }) });
    stack.undo();
    expect(stack.canRedo()).toBe(true);
    stack.push({ name: 'c2', execute: (d) => ({ ...d, title: 'y' }), undo: (d) => ({ ...d, title: 'a' }) });
    expect(stack.canRedo()).toBe(false);
  });

  it('executeMacro is a single undo unit', () => {
    const stack = createCommandStack(docWithTitle('a'));
    const after = stack.executeMacro('macro', [
      { name: 'm1', execute: (d) => ({ ...d, title: 'b' }), undo: (d) => ({ ...d, title: 'a' }) },
      { name: 'm2', execute: (d) => ({ ...d, title: 'c' }), undo: (d) => ({ ...d, title: 'b' }) },
    ]);
    expect(after.title).toBe('c');
    expect(stack.depth().undo).toBe(1);
    const undone = stack.undo();
    expect(undone?.title).toBe('a');
    const redone = stack.redo();
    expect(redone?.title).toBe('c');
  });

  it('coalesces same-key commands within the time window into one undo', () => {
    let t = 0;
    const stack = createCommandStack(docWithTitle('a'), { now: () => t, coalesceWindowMs: 800 });
    // 连续两次同 key（模拟拖拽）
    stack.push({ name: 'move', coalesceKey: 'move', execute: (d) => ({ ...d, title: 'b' }), undo: (d) => ({ ...d, title: 'a' }) });
    t = 100;
    const afterSecond = stack.push({ name: 'move', coalesceKey: 'move', execute: (d) => ({ ...d, title: 'c' }), undo: (d) => ({ ...d, title: 'b' }) });
    expect(afterSecond.title).toBe('c');
    // 合并后只有一条
    expect(stack.depth().undo).toBe(1);
    // 一次 undo 回到起点
    const undone = stack.undo();
    expect(undone?.title).toBe('a');
  });

  it('does NOT coalesce when gap exceeds window', () => {
    vi.useFakeTimers();
    let t = 0;
    const stack = createCommandStack(docWithTitle('a'), { now: () => t, coalesceWindowMs: 800 });
    stack.push({ name: 'move', coalesceKey: 'move', execute: (d) => ({ ...d, title: 'b' }), undo: (d) => ({ ...d, title: 'a' }) });
    t = 1000; // 超出窗口
    stack.push({ name: 'move', coalesceKey: 'move', execute: (d) => ({ ...d, title: 'c' }), undo: (d) => ({ ...d, title: 'b' }) });
    expect(stack.depth().undo).toBe(2);
    vi.useRealTimers();
  });

  it('does NOT coalesce different keys', () => {
    const stack = createCommandStack(docWithTitle('a'));
    stack.push({ name: 'move', coalesceKey: 'move', execute: (d) => ({ ...d, title: 'b' }), undo: (d) => ({ ...d, title: 'a' }) });
    stack.push({ name: 'resize', coalesceKey: 'resize', execute: (d) => ({ ...d, title: 'c' }), undo: (d) => ({ ...d, title: 'b' }) });
    expect(stack.depth().undo).toBe(2);
  });
});
