import { useState } from 'react';
import { Pin, ChevronDown, Copy, Trash2, Shapes } from 'lucide-react';
import { P0_BLOCK_TYPES, type BlockNode, type BlockType } from '@drawpaper/core';
import { useEditorApi } from '../canvas/editor-context';

/** P1 新块型（块类型切换器与 P0 并列）。 */
const P1_BLOCK_TYPES: readonly BlockType[] = ['table', 'code', 'equation', 'bookmark', 'attachment', 'reminder'];
const ALL_BLOCK_TYPES: readonly BlockType[] = [...P0_BLOCK_TYPES, ...P1_BLOCK_TYPES];

/** 8 色标签色板（块背景色；第一项为无色）。 */
export const BLOCK_COLORS: readonly { name: string; bg: string }[] = [
  { name: '无色', bg: 'transparent' },
  { name: '浅黄', bg: '#FEF9C3' },
  { name: '浅红', bg: '#FEE2E2' },
  { name: '浅蓝', bg: '#DBEAFE' },
  { name: '浅绿', bg: '#D1FAE5' },
  { name: '浅紫', bg: '#EDE9FE' },
  { name: '浅粉', bg: '#FCE7F3' },
  { name: '浅橙', bg: '#FFEDD5' },
];

const TYPE_LABEL: Record<BlockType, string> = {
  text: '文本',
  heading: '标题',
  todo: '待办',
  bullet: '列表',
  image: '图片',
  note: '便签',
  group: '分组',
  table: '表格',
  code: '代码',
  equation: '公式',
  bookmark: '书签',
  attachment: '附件',
  reminder: '提醒',
};

interface BlockHoverToolbarProps {
  block: BlockNode;
  childCount: number;
}

/** hover 工具条：块类型切换 / 8 色标签 / 置顶 / 折叠 / 复制 / 删除。 */
export function BlockHoverToolbar({ block, childCount }: BlockHoverToolbarProps) {
  const api = useEditorApi();
  const [typeOpen, setTypeOpen] = useState(false);

  return (
    <div
      className="flex items-center gap-0.5 rounded-md border bg-[hsl(var(--popover))] text-[hsl(var(--popover-foreground))] px-1 py-0.5 shadow-md"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        title="块类型"
        className="relative flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
        onClick={() => setTypeOpen((v) => !v)}
      >
        <Shapes size={12} />
        {TYPE_LABEL[block.type]}
      </button>
      {typeOpen && (
        <div className="absolute left-0 top-6 z-50 w-28 rounded-md border bg-[hsl(var(--popover))] text-[hsl(var(--popover-foreground))] py-1 shadow-lg">
          {ALL_BLOCK_TYPES.map((t) => (
            <button
              key={t}
              className="block w-full px-2 py-0.5 text-left text-[11px] hover:bg-[hsl(var(--accent))]"
              onClick={() => {
                api.setBlockType(block.id, t);
                setTypeOpen(false);
              }}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      )}

      <span className="mx-0.5 h-3 w-px bg-[hsl(var(--border))]" />

      {BLOCK_COLORS.map((c) => (
        <button
          key={c.name}
          title={c.name}
          className="h-3.5 w-3.5 rounded-full border border-[hsl(var(--border))]"
          style={{ background: c.bg === 'transparent' ? 'hsl(var(--node-bg))' : c.bg }}
          onClick={() => api.setBlockStyle(block.id, { bg: c.bg === 'transparent' ? undefined : c.bg })}
        />
      ))}

      <span className="mx-0.5 h-3 w-px bg-[hsl(var(--border))]" />

      <button
        title={block.pinned ? '取消置顶' : '置顶'}
        className={`rounded p-0.5 hover:bg-slate-100 ${block.pinned ? 'text-amber-500' : 'text-slate-500'}`}
        onClick={() => api.togglePin(block.id)}
      >
        <Pin size={12} />
      </button>
      {childCount > 0 && (
        <button
          title={block.collapsed ? '展开子分支' : '折叠子分支'}
          className="rounded p-0.5 text-slate-500 hover:bg-slate-100"
          onClick={() => api.toggleCollapse(block.id)}
        >
          <ChevronDown size={12} className={block.collapsed ? 'rotate-180' : ''} />
        </button>
      )}
      <button
        title="复制"
        className="rounded p-0.5 text-slate-500 hover:bg-slate-100"
        onClick={() => {
          api.setSelection([block.id]);
          api.duplicate();
        }}
      >
        <Copy size={12} />
      </button>
      <button
        title="删除"
        className="rounded p-0.5 text-slate-500 hover:bg-slate-100 hover:text-red-500"
        onClick={() => api.deleteNodes([block.id])}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}
