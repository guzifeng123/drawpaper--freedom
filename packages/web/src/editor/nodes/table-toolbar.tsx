import { memo } from 'react';
import type { Editor } from '@tiptap/react';
import { Rows3, Columns3, Trash2, Heading } from 'lucide-react';

/**
 * 表格块编辑态工具条：加行/加列/删行/删列/切换表头。
 * 直接走 Tiptap table 扩展命令（addRowAfter/addColumnAfter/deleteRow/deleteColumn/toggleHeaderRow）。
 * 按钮 ≥32px 触控友好。
 */
export const TableToolbar = memo(function TableToolbar({ editor }: { editor: Editor }) {
  const run = (fn: (chain: ReturnType<Editor['chain']>) => unknown) => {
    const chain = editor.chain().focus();
    fn(chain);
    chain.run();
  };
  const btn =
    'flex h-8 min-w-8 items-center justify-center rounded px-1.5 text-[11px] text-[hsl(var(--popover-foreground))] hover:bg-[hsl(var(--accent))]';
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
    </div>
  );
});
