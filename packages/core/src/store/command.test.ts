import { describe, it, expect, vi } from 'vitest';
import { createCommandStack, DEFAULT_MAX_HISTORY } from './command.js';
import type { Command } from './command.js';
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

/**
 * 可数命令模型：doc.title = "S<n>"，起始 S0。
 * 第 i 条命令 execute: S{i-1} → S{i}，undo: S{i} → S{i-1}。
 * 纯标题翻转、闭包不依赖前置命令，因此裁剪掉最旧命令后，剩余命令的逆序链仍自洽——
 * undo C{k} 总是把当前 S{k} 翻回 S{k-1}，与「是谁产生了 S{k}」无关。
 */
function countingCmd(i: number): Command {
  return {
    name: `c${i}`,
    execute: (d) => ({ ...d, title: `S${i}` }),
    undo: (d) => ({ ...d, title: `S${i - 1}` }),
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

describe('undo history cap (maxHistory)', () => {
  it('① keeps undoStack ≤ default cap and stays undoable', () => {
    const stack = createCommandStack(docWithTitle('S0'));
    for (let i = 1; i <= 250; i++) stack.push(countingCmd(i));
    expect(DEFAULT_MAX_HISTORY).toBe(200);
    expect(stack.depth().undo).toBe(DEFAULT_MAX_HISTORY);
    expect(stack.canUndo()).toBe(true);
    // 被裁掉的是最旧的 C1..C50：当前文档仍是最新 S250
    expect(stack.push(countingCmd(251)).title).toBe('S251');
    expect(stack.depth().undo).toBe(DEFAULT_MAX_HISTORY);
  });

  it('② undo floor equals doc after the first (total - cap) commands', () => {
    const stack = createCommandStack(docWithTitle('S0'));
    for (let i = 1; i <= 250; i++) stack.push(countingCmd(i));
    expect(stack.depth().undo).toBe(200);

    // 参考文档：单独执行完前 50 条（未触发裁剪）
    const ref = createCommandStack(docWithTitle('S0'));
    let refDoc: KBNoteDoc = docWithTitle('S0');
    for (let i = 1; i <= 50; i++) refDoc = ref.push(countingCmd(i));

    // 一路 undo 到底（200 次）
    let last: KBNoteDoc | undefined;
    for (let k = 0; k < 200; k++) last = stack.undo();
    expect(last?.title).toBe('S50');
    // 文档内容 = 执行完前 50 条命令后的文档
    expect(last?.title).toBe(refDoc.title);
    // 再 undo → undefined / canUndo=false
    expect(stack.canUndo()).toBe(false);
    expect(stack.undo()).toBeUndefined();
  });

  it('③ redo chain over the surviving segment is complete and correct', () => {
    const stack = createCommandStack(docWithTitle('S0'));
    for (let i = 1; i <= 250; i++) stack.push(countingCmd(i));
    for (let k = 0; k < 200; k++) stack.undo(); // floor S50
    // redo 回整段存活命令
    let redone: KBNoteDoc | undefined;
    for (let k = 0; k < 200; k++) redone = stack.redo();
    expect(redone?.title).toBe('S250');
    expect(stack.canRedo()).toBe(false);
    expect(stack.redo()).toBeUndefined();
  });

  it('④ coalesced window does not grow count; cap still applies on top', () => {
    let t = 0;
    const stack = createCommandStack(docWithTitle('S0'), {
      now: () => t,
      coalesceWindowMs: 800,
      maxHistory: 5,
    });
    // 同 key 窗口内连推 10 条 → 合并成 1 条（不占 10 条）
    for (let i = 1; i <= 10; i++) {
      t = i * 50;
      stack.push({
        name: 'move',
        coalesceKey: 'move',
        execute: (d) => ({ ...d, title: `m${i}` }),
        undo: (d) => ({ ...d, title: 'S0' }),
      });
    }
    expect(stack.depth().undo).toBe(1); // coalesce 合并不额外占条
    // 再推 6 条独立命令 → 7 条超出上限 5，裁掉最旧（含合并条）2 条
    for (let i = 1; i <= 6; i++) stack.push(countingCmd(i));
    expect(stack.depth().undo).toBe(5);
  });

  it('⑤ executeMacro counts as ONE entry toward the cap', () => {
    const stack = createCommandStack(docWithTitle('S0'), { maxHistory: 3 });
    stack.push(countingCmd(1));
    // 宏内 3 条子命令 → 整体只压 1 条
    stack.executeMacro('big', [countingCmd(2), countingCmd(3), countingCmd(4)]);
    expect(stack.depth().undo).toBe(2);
    stack.push(countingCmd(5));
    expect(stack.depth().undo).toBe(3);
    stack.push(countingCmd(6)); // 4 → 裁掉最旧 C1
    expect(stack.depth().undo).toBe(3);
    // 一路 undo：宏整体作为 1 步回退，停在最旧存活命令（宏）执行后 = S1
    let last: KBNoteDoc | undefined;
    while (stack.canUndo()) last = stack.undo();
    expect(last?.title).toBe('S1');
    expect(stack.canUndo()).toBe(false);
  });

  it('⑥ custom maxHistory takes effect immediately', () => {
    const stack = createCommandStack(docWithTitle('S0'), { maxHistory: 5 });
    for (let i = 1; i <= 10; i++) stack.push(countingCmd(i));
    expect(stack.depth().undo).toBe(5);
  });

  it('⑦ trimmed stack stays self-consistent: partial undo then new push', () => {
    const stack = createCommandStack(docWithTitle('S0'));
    for (let i = 1; i <= 250; i++) stack.push(countingCmd(i)); // floor S50
    stack.undo();
    stack.undo();
    const back2 = stack.undo();
    expect(back2?.title).toBe('S247');
    expect(stack.depth().redo).toBe(3);
    // 新 push → 清空 redo，不破坏其余链
    stack.push(countingCmd(251));
    expect(stack.canRedo()).toBe(false);
    expect(stack.depth().undo).toBe(198); // 200 - 3 + 1（未再触发裁剪）
    // 一路 undo 到底仍停在 S50（C51 执行后），无状态错乱 / 文档损坏
    let last: KBNoteDoc | undefined;
    while (stack.canUndo()) last = stack.undo();
    expect(last?.title).toBe('S50');
  });

  it('maxHistory <= 0 disables the cap (unlimited) — locked semantics', () => {
    const zero = createCommandStack(docWithTitle('S0'), { maxHistory: 0 });
    for (let i = 1; i <= 500; i++) zero.push(countingCmd(i));
    expect(zero.depth().undo).toBe(500);

    const neg = createCommandStack(docWithTitle('S0'), { maxHistory: -10 });
    for (let i = 1; i <= 300; i++) neg.push(countingCmd(i));
    expect(neg.depth().undo).toBe(300);
  });
});
