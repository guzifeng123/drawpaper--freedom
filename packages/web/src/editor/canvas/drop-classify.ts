/**
 * drop-classify.ts —— 桌面端文件拖入画布的分类纯函数（无 DOM 依赖，可单测）。
 *
 * 规则：
 * - .txt / .md / .markdown → 文本块（读纯文本，按行成段落）
 * - 图片（image/* 或常见图片扩展名）→ 图片块（走 OPFS 资产管线）
 * - 其余 → 附件块（走 OPFS；不可用时上层 toast 且不建坏块）
 */

export type DropKind = 'text' | 'image' | 'attachment' | 'unsupported';

const TEXT_EXT = new Set(['.txt', '.md', '.markdown']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

export function classifyFile(name: string, mime: string): DropKind {
  const lower = name.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf('.'));
  if (TEXT_EXT.has(ext)) return 'text';
  if (mime.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image';
  // 已知类型但非文本/图片 → 附件（pdf/doc/zip 等）
  if (ext && ext.length > 1) return 'attachment';
  return 'unsupported';
}

/** 多文件拖入的错位排列偏移（世界坐标）。 */
export function dropOffset(index: number): { dx: number; dy: number } {
  return { dx: (index % 5) * 24, dy: (index % 5) * 24 };
}
