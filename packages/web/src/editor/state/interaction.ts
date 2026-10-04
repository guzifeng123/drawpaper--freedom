/**
 * interaction.ts —— 画布交互状态机（纯函数，vitest 覆盖迁移表）。
 *
 * 状态：select / connect / pan / box-select / insert，外加 editing 标志（块内编辑）。
 * 迁移表与 Esc 分层退出（§4.6）：
 *   Esc: editing=true → 退出编辑仍选中（state 不变）；
 *        state∈{connect,box-select,insert,pan} → 回 select；
 *        state=select → 保持 select（canvas 收到 clearSelection 后清空选择）。
 */

export type InteractionStateKind = 'select' | 'connect' | 'pan' | 'box-select' | 'insert';

export interface EditorInteraction {
  kind: InteractionStateKind;
  editing: boolean;
}

export type InteractionEvent =
  | { type: 'tool-select' }
  | { type: 'tool-connect' }
  | { type: 'tool-pan' }
  | { type: 'start-connect' }
  | { type: 'start-pan' }
  | { type: 'start-box-select' }
  | { type: 'start-insert' }
  | { type: 'enter-edit' }
  | { type: 'exit-edit' }
  | { type: 'commit' }
  | { type: 'esc' };

export interface ReduceResult {
  next: EditorInteraction;
  /** Esc 落到 select 层时，canvas 应清空选择（第二次 Esc 取消选中）。 */
  clearSelection: boolean;
}

export function initialInteraction(): EditorInteraction {
  return { kind: 'select', editing: false };
}

export function reduceInteraction(cur: EditorInteraction, ev: InteractionEvent): ReduceResult {
  switch (ev.type) {
    case 'tool-select':
      return { next: { kind: 'select', editing: cur.editing }, clearSelection: false };
    case 'tool-connect':
      return { next: { kind: 'connect', editing: cur.editing }, clearSelection: false };
    case 'tool-pan':
      return { next: { kind: 'pan', editing: cur.editing }, clearSelection: false };
    case 'start-connect':
      return { next: { kind: 'connect', editing: cur.editing }, clearSelection: false };
    case 'start-pan':
      return { next: { kind: 'pan', editing: cur.editing }, clearSelection: false };
    case 'start-box-select':
      return { next: { kind: 'box-select', editing: cur.editing }, clearSelection: false };
    case 'start-insert':
      return { next: { kind: 'insert', editing: cur.editing }, clearSelection: false };
    case 'enter-edit':
      return { next: { kind: cur.kind, editing: true }, clearSelection: false };
    case 'exit-edit':
      return { next: { kind: cur.kind, editing: false }, clearSelection: false };
    case 'commit':
      return { next: { kind: 'select', editing: cur.editing }, clearSelection: false };
    case 'esc': {
      if (cur.editing) {
        // 第一次 Esc：退出编辑，仍选中
        return { next: { kind: cur.kind, editing: false }, clearSelection: false };
      }
      if (cur.kind !== 'select') {
        // 连线/框选/插入/平移进行中：取消回 select
        return { next: { kind: 'select', editing: false }, clearSelection: false };
      }
      // select 层第二次 Esc：清空选择
      return { next: { kind: 'select', editing: false }, clearSelection: true };
    }
  }
}
