import type { KBNoteDoc, BlockNode } from '@drawpaper/core';
import { buildMainTree } from '@drawpaper/core';
import { tiptapToMarkdown } from './render/tiptap-to-markdown';

/**
 * 由主树 DFS 生成 Markdown 大纲（下载 .md）。
 *  - 树根 → 一级标题；每深一级降一级标题；
 *  - todo 块 → - [ ]/[x]；bullet → -；note → 引用块；image → 占位链接；
 *  - 图片只留占位链接（附件本体走 OPFS，不内嵌）。
 */

function nodeBody(node: BlockNode): string {
  const md = tiptapToMarkdown(node.content.data).trim();
  if (node.type === 'image') {
    const src = node.image?.src ?? '';
    const alt = node.image?.alt ?? node.id;
    return src ? `![${alt}](${src})` : '_（图片占位）_';
  }
  if (node.type === 'note') {
    return md ? md.split('\n').map((l) => '> ' + l).join('\n') : '';
  }
  return md;
}

export function docToMarkdown(doc: KBNoteDoc): string {
  const tree = buildMainTree(doc.nodes, doc.edges);
  const out: string[] = [`# ${doc.title}`, ''];

  const visit = (nodeId: string, depth: number): void => {
    const node = doc.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const headingLevel = Math.min(depth + 1, 6);
    const body = nodeBody(node);

    if (node.type === 'todo') {
      out.push(`- [${node.todo?.checked ? 'x' : ' '}] ${body.replace(/\n+/g, ' ')}`);
    } else if (node.type === 'bullet') {
      out.push(`- ${body.replace(/\n+/g, ' ')}`);
    } else {
      // 标题行：用块内第一行文本或块类型占位。
      const firstLine = body.split('\n')[0]?.trim() ?? '';
      const heading = firstLine || (node.type === 'group' ? '（分组）' : node.id);
      out.push(`${'#'.repeat(headingLevel)} ${heading}`);
      const rest = body.split('\n').slice(1).join('\n').trim();
      if (rest) out.push('', rest);
      out.push('');
    }

    const tn = tree.nodes[nodeId];
    for (const child of tn?.children ?? []) visit(child, depth + 1);
  };

  for (const root of tree.roots) visit(root, 0);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** 触发浏览器下载一个文本文件。 */
export function downloadTextFile(filename: string, text: string, mime = 'text/markdown'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
