import { memo } from 'react';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { Rows3, Columns3, Trash2, Heading, Combine, SplitSquareHorizontal } from 'lucide-react';

/**
 * 表格块编辑态工具条：加行/加列/删行/删列/切换表头/合并单元格/拆分单元格。
 * 直接走 Tiptap table 扩展命令。按钮 ≥32px 触控友好。
 *
 * 合并/拆分按当前 selection 动态启用：
 *  - mergeCells：仅当用户拖选了多个单元格（ProseMirror CellSelection）时可用；
 *  - splitCell：仅当光标落在合并过的单元格（colSpan/rowSpan>1）时可用。
 */
export const TableToolbar = memo(function TableToolbar({ editor }: { editor: Editor }) {
  const run = (fn: (chain: ReturnType<Editor['chain']>) => unknown) => {
    const chain = editor.chain().focus();
    fn(chain);
    chain.run();
  };
  // 合并/拆分作用于已存在的 CellSelection：不能 .focus()（会折叠选区）。
  const runOnSelection = (cmd: 'mergeCells' | 'splitCell') => {
    editor.chain()[cmd]().run();
  };
  // 订阅事务，使合并/拆分按钮的启用态随选区实时刷新。
  useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      canMerge: e.can().mergeCells(),
      canSplit: e.can().splitCell(),
    }),
  });
  const canMerge = editor.can().mergeCells();
  const canSplit = editor.can().splitCell();

  const btn =
    'flex h-8 min-w-8 items-center justify-center rounded px-1.5 text-[11px] text-[hsl(var(--popover-foreground))] hover:bg-[hsl(var(--accent))] disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <div
      className="flex items-center gap-0.5 rounded-md border bg-[hsl(var(--popover))] px-1 py-0.5 shadow-md"
      onMouseDown={(e) => e.preventDefault()}
    >
      <button className={btn} title="加行（下方）" onClick={() => run((c) => c.addRowAfter())}>
        <Rows3 size={14} /> 加行
      </button>
      <button className={btn} title="加列（右侧）" onClick={() => run((c) => c.addColumnAfter())}>
        <Columns3 size={14} /> 加列
      </button>
      <button className={btn} title="删行" onClick={() => run((c) => c.deleteRow())}>
        <Trash2 size={14} /> 删行
      </button>
      <button className={btn} title="删列" onClick={() => run((c) => c.deleteColumn())}>
        <Trash2 size={14} /> 删列
      </button>
      <button className={btn} title="切换表头行" onClick={() => run((c) => c.toggleHeaderRow())}>
        <Heading size={14} /> 表头
      </button>
      <span className="mx-0.5 h-4 w-px bg-[hsl(var(--border))]" />
      <button
        className={btn}
        title={canMerge ? '合并所选单元格' : '拖选多个单元格后可合并'}
        disabled={!canMerge}
        onClick={() => runOnSelection('mergeCells')}
      >
        <Combine size={14} /> 合并
      </button>
      <button
        className={btn}
        title={canSplit ? '拆分当前单元格' : '光标需位于合并过的单元格'}
        disabled={!canSplit}
        onClick={() => runOnSelection('splitCell')}
      >
        <SplitSquareHorizontal size={14} /> 拆分
      </button>
    </div>
  );
});
