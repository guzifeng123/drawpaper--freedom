import type { NodeProps } from '@xyflow/react';
import { SquareCheck } from 'lucide-react';
import { useEditorApi } from '../canvas/editor-context';
import { StaticHtml } from '../tiptap/static';
import { BlockShell } from './BlockShell';
import type { AppNode } from './types';

/** 文本块。 */
export function TextBlock({ data, selected }: NodeProps<AppNode>) {
  const block = data.block;
  return (
    <BlockShell
      block={block}
      selected={selected}
      renderStatic={() => <StaticHtml json={block.content.data} className="py-3" />}
    />
  );
}

/** 标题块（按 heading.level 1-3 放大字号）。 */
export function HeadingBlock({ data, selected }: NodeProps<AppNode>) {
  const block = data.block;
  const level = block.heading?.level ?? 1;
  const size = level === 1 ? 'text-xl' : level === 2 ? 'text-lg' : 'text-base';
  return (
    <BlockShell
      block={block}
      selected={selected}
      shellClassName="bg-slate-50"
      renderStatic={() => (
        <StaticHtml json={block.content.data} className={`py-3 font-bold ${size}`} />
      )}
    />
  );
}

/** 待办块：勾选框 + 文本；勾选走 api.toggleTodo。 */
export function TodoBlock({ data, selected }: NodeProps<AppNode>) {
  const block = data.block;
  const api = useEditorApi();
  const checked = !!block.todo?.checked;
  return (
    <BlockShell
      block={block}
      selected={selected}
      renderStatic={() => (
        <div className="flex items-start gap-2 py-2.5">
          <button
            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
              checked ? 'border-blue-500 bg-blue-500 text-white' : 'border-slate-300'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              api.toggleTodo(block.id);
            }}
          >
            {checked && <SquareCheck size={12} />}
          </button>
          <StaticHtml json={block.content.data} className={`flex-1 ${checked ? 'text-slate-400 line-through' : ''}`} />
        </div>
      )}
    />
  );
}

/** 无序列表块（一条目一块，区别于块内富文本列表）。 */
export function BulletBlock({ data, selected }: NodeProps<AppNode>) {
  const block = data.block;
  return (
    <BlockShell
      block={block}
      selected={selected}
      renderStatic={() => (
        <div className="flex items-start gap-2 py-2.5">
          <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-500" />
          <StaticHtml json={block.content.data} className="flex-1" />
        </div>
      )}
    />
  );
}

/** 便签块：暖色底。 */
export function NoteBlock({ data, selected }: NodeProps<AppNode>) {
  const block = data.block;
  return (
    <BlockShell
      block={block}
      selected={selected}
      shellClassName="bg-amber-50"
      renderStatic={() => <StaticHtml json={block.content.data} className="py-3" />}
    />
  );
}

/** 图片块：img + NodeResizer 四角等比缩放。 */
export function ImageBlock({ data, selected }: NodeProps<AppNode>) {
  const block = data.block;
  return (
    <BlockShell
      block={block}
      selected={selected}
      keepAspectRatio
      shellClassName="!p-1"
      renderStatic={() =>
        block.image?.src ? (
          <img
            src={block.image.src}
            alt={block.image.alt ?? ''}
            className="h-full w-full rounded object-contain"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">图片</div>
        )
      }
    />
  );
}

/** 分组容器：更大圆角、视觉底色；子块由布局定位，容器仅视觉背景。 */
export function GroupBlock({ data, selected }: NodeProps<AppNode>) {
  const block = data.block;
  return (
    <BlockShell
      block={block}
      selected={selected}
      shellClassName="border-2 border-dashed !rounded-xl bg-blue-50/50"
      renderStatic={() => (
        <div className="py-2">
          <div className="mb-1 px-1 text-xs font-semibold text-blue-700/80">
            <StaticHtml json={block.content.data} />
          </div>
        </div>
      )}
    />
  );
}
