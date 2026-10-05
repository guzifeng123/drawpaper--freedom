import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Position, NodeResizer, NodeToolbar, type NodeProps } from '@xyflow/react';
import { EditorContent, type Editor } from '@tiptap/react';
import type { BlockNode } from '@drawpaper/core';
import { useEditorApi, useEditingNodeId, useChildCount } from '../canvas/editor-context';
import { createBlockEditor } from '../tiptap/createBlockEditor';
import { SlashMenu, type SlashCommand } from '../tiptap/slash-menu';
import { DocRefMention } from '../tiptap/doc-ref-mention';
import { BlockHoverToolbar } from './block-hover-toolbar';
import { TableToolbar } from './table-toolbar';
import { SourceHandles as ConnectHandles, TargetHandles } from './ConnectHandle';
import type { AppNode } from './types';

/**
 * BlockShell —— 所有块类型的通用外壳：
 * 选中描边 / hover 工具条 / 四角+右边缩放（最小宽 160，文字回流，高度实测上报）/
 * 双击进入 Tiptap 编辑（nodrag + nowheel + stopPropagation）/ 四向 Handle /
 * 折叠角标 / pinned 指示。
 */

const PAD_Y = 14;

interface BlockShellProps {
  block: BlockNode;
  selected: boolean;
  /** 静态（非编辑）内容渲染。 */
  renderStatic: () => ReactNode;
  /** 额外 chrome 类名（便签暖色底 / 分组视觉底色等）。 */
  shellClassName?: string;
  contentClassName?: string;
  /** 图片块：四角等比缩放。 */
  keepAspectRatio?: boolean;
  /**
   * 自定义编辑 UI（P1 特殊块：公式/书签/附件/提醒）。
   * 提供后，双击进入编辑时渲染它而非 Tiptap（这些块不是富文本）。
   */
  renderEditor?: () => ReactNode;
}

export const BlockShell = memo(function BlockShell({
  block,
  selected,
  renderStatic,
  shellClassName = '',
  contentClassName = '',
  keepAspectRatio = false,
  renderEditor,
}: BlockShellProps) {
  const api = useEditorApi();
  const editingNodeId = useEditingNodeId();
  const childCount = useChildCount(block.id);
  const isEditing = editingNodeId === block.id;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  // 斜杠菜单「图片」：隐藏文件选择器，选中后走统一压缩+OPFS 管线。
  const pickImageRef = useRef<HTMLInputElement>(null);

  // 进入编辑：挂载真实 Tiptap Editor（特殊块提供 renderEditor 时跳过）
  useEffect(() => {
    if (!isEditing || renderEditor) return;
    let cancelled = false;
    let ed: Editor | null = null;
    // createBlockEditor 现可异步（代码块内容时懒加载 lowlight）；加载完再挂载。
    void createBlockEditor({
      content: block.content.data,
      autofocus: 'end',
      onUpdate: (json) => api.updateContent(block.id, json),
    }).then((editor) => {
      if (cancelled) {
        editor.destroy();
        return;
      }
      ed = editor;
      const dom = ed.view.dom;

      const onPaste = (ev: ClipboardEvent) => {
        const item = Array.from(ev.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'));
        if (item) {
          ev.preventDefault();
          ev.stopPropagation();
          const file = item.getAsFile();
          if (file) {
            // 统一管线：压缩 → OPFS（src 存 assetRef）→ 不可用降级 dataURL。
            void api.ingestImage(file, block.x + block.width + 48, block.y);
          }
        }
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          api.setEditingNode(null);
        }
      };
      dom.addEventListener('paste', onPaste, true);
      dom.addEventListener('keydown', onKey, true);
      setEditor(ed);
    });
    return () => {
      cancelled = true;
      ed?.destroy();
      setEditor(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, block.id, block.type]);

  // ResizeObserver：实测内容高度 → 上报派生尺寸（高度自动回流）
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const report = () => {
      api.setMeasuredSizes({ [block.id]: { height: Math.max(32, el.scrollHeight + PAD_Y * 2) } });
    };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    // 不在这里同步 read el.scrollHeight：大文档首屏 N 个节点会各触发一次强制
    // reflow（O(N) 同步布局）。ResizeObserver 自身在 observe 后会异步回调一次，
    // 高度经 create-editor-api 的 rAF 合并批量上报，语义一致。
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.id, isEditing]);

  const onSlashCommand = (cmd: SlashCommand) => {
    if (cmd.kind === 'inline' && editor) {
      const chain = editor.chain().focus();
      switch (cmd.action) {
        case 'bold':
          chain.toggleBold().run();
          break;
        case 'italic':
          chain.toggleItalic().run();
          break;
        case 'underline':
          chain.toggleUnderline().run();
          break;
        case 'highlight':
          chain.toggleHighlight().run();
          break;
        case 'link': {
          const url = window.prompt('链接地址', 'https://');
          if (url) chain.setLink({ href: url }).run();
          break;
        }
      }
    } else if (cmd.kind === 'block') {
      if (cmd.blockType === 'image') {
        // 斜杠插入图片：与粘贴/拖入共用 ingestImage 管线（选文件后压缩→OPFS）。
        api.setEditingNode(null);
        pickImageRef.current?.click();
        return;
      }
      api.setEditingNode(null);
      api.setBlockType(block.id, cmd.blockType);
    }
  };

  const shellStyle: React.CSSProperties = {
    background: block.style.bg ?? 'hsl(var(--node-bg))',
    borderColor: selected ? '#3b82f6' : block.style.border ?? 'hsl(var(--node-border))',
  };

  return (
    <div
      className={`relative flex h-full w-full flex-col rounded-lg border text-[hsl(var(--node-text))] shadow-sm transition-shadow ${
        selected ? 'shadow-md ring-2 ring-blue-400/40' : ''
      } ${shellClassName} ${isEditing ? 'nodrag nowheel' : ''}`}
      style={shellStyle}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!isEditing) api.setEditingNode(block.id);
      }}
      onMouseDown={(e) => {
        if (isEditing) e.stopPropagation();
      }}
    >
      {/* 缩放手柄：文字块只允许横向调宽；图片块四角等比 */}
      <NodeResizer
        isVisible={selected}
        minWidth={160}
        keepAspectRatio={keepAspectRatio}
        lineClassName="!bg-blue-400"
        onResize={(_, params) => {
          api.resizeNode(block.id, params.width, keepAspectRatio ? params.height : block.height);
        }}
      />

      {/* 四向 Handle：右/下出（source）、左/上入（target），均支持长按拖连 */}
      <ConnectHandles nodeId={block.id} />
      <TargetHandles nodeId={block.id} />

      {/* hover / 选中工具条 */}
      <NodeToolbar position={Position.Top} align="start" isVisible={selected} className="absolute -top-9 left-0">
        <BlockHoverToolbar block={block} childCount={childCount} />
      </NodeToolbar>

      {/* pinned 指示 */}
      {block.pinned && (
        <div className="absolute -right-1 -top-1 z-10 rounded-full bg-amber-400 px-1 text-[9px] text-white">
          钉
        </div>
      )}
      {/* 折叠角标 */}
      {childCount > 0 && (
        <button
          className="absolute -bottom-2 right-2 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-700 px-1 text-[10px] text-white"
          title={block.collapsed ? '展开子分支' : '折叠子分支'}
          onClick={(e) => {
            e.stopPropagation();
            api.toggleCollapse(block.id);
          }}
        >
          {childCount}
        </button>
      )}

      {/* 内容区 */}
      <div ref={bodyRef} className={`min-h-6 flex-1 overflow-hidden px-3 py-0 text-sm leading-5 ${contentClassName}`}>
        {isEditing && renderEditor ? (
          renderEditor()
        ) : isEditing && editor ? (
          <>
            {block.type === 'table' && <TableToolbar editor={editor} />}
            <div className="tiptap-content" data-nodeeditor>
              <EditorContent editor={editor} />
            </div>
            <SlashMenu editor={editor} onCommand={onSlashCommand} />
            <DocRefMention editor={editor} />
          </>
        ) : (
          renderStatic()
        )}
      </div>
      <input
        ref={pickImageRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void api.ingestImage(f, block.x, block.y);
          e.target.value = '';
        }}
      />
    </div>
  );
});

export type BlockShellNodeProps = NodeProps<AppNode>;
