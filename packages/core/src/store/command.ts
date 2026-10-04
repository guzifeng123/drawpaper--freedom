import type { KBNoteDoc } from '../model/index.js';

/**
 * Command 命令栈：所有对文档的写操作都封装为 Command 对象，天然支持撤销/重做与宏。
 * 本文件只冻结接口签名，实现留 Wave1-C。
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
}

/** 工厂：创建一个命令栈，初始文档为 init。 */
export function createCommandStack(init: KBNoteDoc): CommandStack {
  void init;
  throw new Error('not implemented: wave1-c (createCommandStack)');
}
