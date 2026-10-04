import type { BlockType } from '@drawpaper/core';
import type { BlockContent } from '@drawpaper/core';

/**
 * 各块类型的默认 Tiptap JSON 内容（新建块时用）。
 * 真相格式：{ format: 'tiptap-json', data: ProseMirror doc }。
 */
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
      default:
        return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] };
    }
  })();
  return { format: 'tiptap-json', data };
}

/** 默认新建块尺寸（世界坐标 px）。 */
export const DEFAULT_NODE_SIZE: Record<string, { width: number; height: number }> = {
  text: { width: 220, height: 64 },
  heading: { width: 240, height: 56 },
  todo: { width: 220, height: 40 },
  bullet: { width: 220, height: 40 },
  note: { width: 240, height: 120 },
  image: { width: 240, height: 180 },
  group: { width: 360, height: 240 },
};

/** 提取块内纯文本（搜索/占位用的轻量实现；无 Tiptap 依赖）。 */
export function blockPlainText(content: unknown): string {
  let text = '';
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { text?: string; content?: unknown[] };
    if (typeof n.text === 'string') text += n.text;
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  const data = (content as { data?: unknown })?.data ?? content;
  walk(data);
  return text.trim();
}
