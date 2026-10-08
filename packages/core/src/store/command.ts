import type { KBNoteDoc } from '../model/index.js';

/**
 * 默认撤销历史上限：undoStack 最多保留的命令条数。
 *
 * 取值理由：覆盖一次正常人工编辑会话的撤销深度——连续输入 / 拖拽会被 coalesce
 * 合并为少量手势条，宏（executeMacro）整体只占 1 条，真实「独立撤销点」远小于此；
 * 200 条足以让用户回退到本次会话早期，同时给超长会话反复编辑、以及超大文档上每条
 * 命令闭包所持有的节点坐标 / 边引用等，设一个硬顶，消除 undoStack 随会话单调增长的
 * 内存膨胀（10k 块文档上尤其明显）。显式传入 maxHistory 可覆盖；传 <= 0 表示不限制。
 */
export const DEFAULT_MAX_HISTORY = 200;

/**
 * Command 命令栈：所有对文档的写操作都封装为 Command 对象，天然支持撤销/重做与宏。
 *
 * 语义：每条 Command 是一个「文档 → 文档」的纯变换。栈中保存的是「从某一基线文档出发」
 * 的命令；push 后立即执行，undo 时按逆序复合回退。
 *
 * - coalesceKey：同一 coalesceKey 的连续命令，若与上一条的时间间隔 ≤ coalesceWindowMs，
 *   则合并为一条（如拖拽 move、连续输入 content）。合并后的 undo 一次回退整个手势。
 * - executeMacro：把多条命令打包为一次撤销单元（如「一键整理」移动 N 个节点）。
 */

/**
 * 一条可撤销命令。
 * execute 产生新文档状态；undo 回退。store 内部用 immer 不可变更新。
 */
export interface Command {
  /** 命令名（调试/历史用，如 'add-node'）。 */
  name: string;
  /** 执行（返回新文档；或直接操作 draft，由 store 决定）。 */
  execute: (doc: KBNoteDoc) => KBNoteDoc;
  /** 逆操作。 */
  undo: (doc: KBNoteDoc) => KBNoteDoc;
  /**
   * 可选合并键：同一 coalesceKey 的连续命令在防抖窗口内合并为一条
   * （如连续输入 content 更新、连续移动）。
   */
  coalesceKey?: string;
}

/** 命令栈（undo/redo）接口。 */
export interface CommandStack {
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): KBNoteDoc | undefined;
  redo(): KBNoteDoc | undefined;
  /** 推入并执行一条命令。 */
  push(cmd: Command): KBNoteDoc;
  /** 宏命令：把多条命令打包成一次撤销单元（如「一键整理」= 预览+应用+落位）。 */
  executeMacro(name: string, cmds: Command[]): KBNoteDoc;
  /** 栈深度（调试用）。 */
  depth(): { undo: number; redo: number };
  /** 最近一次 undo() 弹出的命令名（含宏名），供 UI 判断是否需要回位相机。 */
  lastUndoName(): string | undefined;
}

/** createCommandStack 可选依赖（时钟/窗口可注入，便于单测用假时钟）。 */
export interface CommandStackOptions {
  /** 时钟注入（默认 Date.now）。 */
  now?: () => number;
  /** 合并时间窗（ms），默认 800。 */
  coalesceWindowMs?: number;
  /**
   * undoStack 最多保留的命令条数（coalesce 合并条、executeMacro 宏条各算 1 条）。
   * push / executeMacro 后若超出上限，丢弃最旧的一条（shift），使其不再可撤销；
   * 剩余命令彼此 undo/redo 仍自洽（见模块说明：丢掉 C1 不破坏 C2..Cn 的逆序链）。
   * 缺省 = DEFAULT_MAX_HISTORY（200）。传 <= 0 表示不限制（无硬顶）。
   */
  maxHistory?: number;
}

interface TimedCommand extends Command {
  /** 推入时间戳（用于 coalesce 窗口判断）。 */
  pushedAt: number;
}

/**
 * 合并两条相邻命令为一条复合命令。
 * 给定 top（先执行，doc0→doc1）与 next（后执行，doc1→doc2）：
 *   - 合并 execute(doc0) = next.execute(top.execute(doc0))  = doc2
 *   - 合并 undo(doc2)   = top.undo(next.undo(doc2))        = doc0
 */
function coalescePair(top: Command, next: Command, coalesceKey: string): Command {
  return {
    name: next.name,
    coalesceKey,
    execute: (doc) => next.execute(top.execute(doc)),
    undo: (doc) => top.undo(next.undo(doc)),
  };
}

/**
 * 工厂：创建一个命令栈，初始文档为 init。
 * @param init  初始文档
 * @param opts  可选：注入时钟 / 调整合并窗口
 */
export function createCommandStack(
  init: KBNoteDoc,
  opts: CommandStackOptions = {},
): CommandStack {
  const now = opts.now ?? (() => Date.now());
  const windowMs = opts.coalesceWindowMs ?? 800;
  // <= 0 视为不限制（无硬顶）；缺省走 DEFAULT_MAX_HISTORY。
  const cap = opts.maxHistory ?? DEFAULT_MAX_HISTORY;

  let current: KBNoteDoc = init;
  const undoStack: TimedCommand[] = [];
  const redoStack: TimedCommand[] = [];
  let lastPoppedName: string | undefined;

  /**
   * 裁剪硬顶：超出上限时丢弃最旧命令（shift），使其不可再撤销。
   * 一次 push 最多让栈长 +1，但用 while 兜底恒保证长度 ≤ cap。
   * 丢掉最旧命令只意味着无法回到它执行之前；剩余命令的逆序链仍自洽，无需快照重写。
   */
  function trimOldest() {
    while (cap > 0 && undoStack.length > cap) {
      undoStack.shift();
    }
  }

  return {
    canUndo() {
      return undoStack.length > 0;
    },
    canRedo() {
      return redoStack.length > 0;
    },

    push(cmd: Command): KBNoteDoc {
      // coalesce：与栈顶同 key 且在时间窗内 → 合并，而非新压一条。
      const top = undoStack[undoStack.length - 1];
      if (cmd.coalesceKey && top && top.coalesceKey === cmd.coalesceKey) {
        const dt = now() - top.pushedAt;
        if (dt <= windowMs) {
          const merged = coalescePair(top, cmd, cmd.coalesceKey);
          // 先在「当前文档」上执行新命令，得到新基线；再用合并命令替换栈顶。
          current = cmd.execute(current);
          undoStack[undoStack.length - 1] = { ...merged, pushedAt: now() };
          redoStack.length = 0;
          return current;
        }
      }

      current = cmd.execute(current);
      undoStack.push({ ...cmd, pushedAt: now() });
      redoStack.length = 0;
      trimOldest();
      return current;
    },

    undo(): KBNoteDoc | undefined {
      const cmd = undoStack.pop();
      if (!cmd) return undefined;
      current = cmd.undo(current);
      redoStack.push(cmd);
      lastPoppedName = cmd.name;
      return current;
    },

    redo(): KBNoteDoc | undefined {
      const cmd = redoStack.pop();
      if (!cmd) return undefined;
      current = cmd.execute(current);
      undoStack.push(cmd);
      return current;
    },

    executeMacro(name: string, cmds: Command[]): KBNoteDoc {
      if (cmds.length === 0) return current;
      const macro: TimedCommand = {
        name,
        // 顺序执行：doc0 -> doc1 -> ... -> docN
        execute: (doc) => cmds.reduce((d, c) => c.execute(d), doc),
        // 逆序回退：docN -> ... -> doc0
        undo: (doc) => {
          let d = doc;
          for (let i = cmds.length - 1; i >= 0; i--) {
            d = (cmds[i] as Command).undo(d);
          }
          return d;
        },
        pushedAt: now(),
      };
      current = macro.execute(current);
      undoStack.push(macro);
      redoStack.length = 0;
      trimOldest();
      return current;
    },

    depth() {
      return { undo: undoStack.length, redo: redoStack.length };
    },

    lastUndoName() {
      return lastPoppedName;
    },
  };
}
