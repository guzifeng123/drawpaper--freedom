import type { BlockType, DocEmbedData } from '@drawpaper/core';
import type { BlockContent } from '@drawpaper/core';

/**
 * 各块类型的默认 Tiptap JSON 内容（新建块时用）。
 * 真相格式：{ format: 'tiptap-json', data: ProseMirror doc }。
 *
 * P1 新块 content.data 形状约定（供导出 agent 对齐，详见 docs/wave3/i-blocks-touch.md）：
 * - table:       data = ProseMirror doc（table > tableRow > tableCell/header），块内 Tiptap 编辑。
 * - code:       data = ProseMirror doc（codeBlock，attrs.language），块内 Tiptap 编辑。
 * - equation:   data = { kind:'equation', source:string }  LaTeX 源码（$...$ 已剥离）。
 * - bookmark:   data = { kind:'bookmark', url, title, description }（不抓网，仅存用户输入）。
 * - attachment: data = { kind:'attachment', assetRef, name, size, mime }。
 * - reminder:   data = { kind:'reminder', dueAt:number, note:string }。
 * - doc-embed（Wave20）: data = { kind:'doc-embed', targetDocId, targetNodeId, titleSnapshot }
 *   跨画布只读块嵌入；host 复用 type='note'，只存引用不复制正文。契约见
 *   packages/core/src/model/doc-embed.ts 与 docs/wave20/block-transclusion.md。
 */

export type { DocEmbedData };

/** P1 特殊块（非 Tiptap 富文本编辑）的 data payload 形状。 */
export interface EquationData {
  kind: 'equation';
  source: string;
}
export interface BookmarkData {
  kind: 'bookmark';
  url: string;
  title: string;
  description: string;
}
export interface AttachmentData {
  kind: 'attachment';
  assetRef: string;
  name: string;
  size: number;
  mime: string;
}
export interface ReminderData {
  kind: 'reminder';
  /** 截止时间 epoch ms（0 = 未设置）。 */
  dueAt: number;
  note: string;
}

/** 新建一个空表格 doc（2 行 2 列，首行为表头）。 */
function emptyTableDoc(): unknown {
  const cell = (): unknown => ({
    type: 'tableCell',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }],
  });
  const header = (): unknown => ({
    type: 'tableHeader',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }],
  });
  const row = (cells: unknown[]): unknown => ({ type: 'tableRow', content: cells });
  return {
    type: 'doc',
    content: [
      {
        type: 'table',
        content: [row([header(), header()]), row([cell(), cell()])],
      },
    ],
  };
}

/** 新建一个空代码块 doc。 */
function emptyCodeDoc(language = 'js'): unknown {
  return {
    type: 'doc',
    content: [{ type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text: '' }] }],
  };
}

export function defaultContentForType(type: BlockType): BlockContent {
  const data = (() => {
    switch (type) {
      case 'heading':
        return { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '' }] }] };
      case 'todo':
        return {
          type: 'doc',
          content: [
            {
              type: 'taskList',
              content: [
                { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] },
              ],
            },
          ],
        };
      case 'bullet':
        return {
          type: 'doc',
          content: [
            {
              type: 'bulletList',
              content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] }],
            },
          ],
        };
      case 'table':
        return emptyTableDoc();
      case 'code':
        return emptyCodeDoc();
      case 'equation':
        return { kind: 'equation', source: '' } satisfies EquationData;
      case 'bookmark':
        return { kind: 'bookmark', url: '', title: '', description: '' } satisfies BookmarkData;
      case 'attachment':
        return { kind: 'attachment', assetRef: '', name: '', size: 0, mime: '' } satisfies AttachmentData;
      case 'reminder':
        return { kind: 'reminder', dueAt: 0, note: '' } satisfies ReminderData;
      default:
        return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] };
    }
  })();
  return { format: 'tiptap-json', data };
}

/** 默认新建块尺寸（世界坐标 px）。editor 侧建块时用此覆盖 core factory 的回退尺寸。 */
export const DEFAULT_NODE_SIZE: Record<string, { width: number; height: number }> = {
  text: { width: 220, height: 64 },
  heading: { width: 240, height: 56 },
  todo: { width: 220, height: 40 },
  bullet: { width: 220, height: 40 },
  note: { width: 240, height: 120 },
  image: { width: 240, height: 180 },
  group: { width: 360, height: 240 },
  // P1 新块型默认尺寸（core factory 回退 260x80，editor 侧传 partial 覆盖）
  table: { width: 340, height: 150 },
  code: { width: 320, height: 130 },
  equation: { width: 260, height: 84 },
  bookmark: { width: 300, height: 96 },
  attachment: { width: 280, height: 76 },
  reminder: { width: 240, height: 64 },
};

/** 提取块内纯文本（搜索/占位用的轻量实现；无 Tiptap 依赖）。 */
export function blockPlainText(content: unknown): string {
  let text = '';
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { text?: string; content?: unknown[]; source?: string; title?: string; name?: string; note?: string };
    if (typeof n.text === 'string') text += n.text;
    // P1 特殊块的可读文本
    if (typeof n.source === 'string') text += n.source;
    if (typeof n.title === 'string') text += n.title;
    if (typeof n.name === 'string') text += n.name;
    if (typeof n.note === 'string') text += n.note;
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  const data = (content as { data?: unknown })?.data ?? content;
  walk(data);
  return text.trim();
}

/** 从任意块 content 中取 P1 特殊 payload（非 P1 特殊类型返回 null）。 */
export function readP1Data<T = unknown>(content: unknown): T | null {
  const data = (content as { data?: unknown })?.data;
  if (data && typeof data === 'object' && (data as { kind?: string }).kind) {
    return data as T;
  }
  return null;
}
