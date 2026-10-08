import type { KBNoteDoc, BlockNode } from '@drawpaper/core';
import { buildMainTree, parseDocEmbedData } from '@drawpaper/core';
import { tiptapToMarkdown } from './render/tiptap-to-markdown';

/**
 * 由主树 DFS 生成 Markdown 大纲（下载 .md）。
 *  - 树根 → 一级标题；每深一级降一级标题；
 *  - todo 块 → - [ ]/[x]；bullet → -；note → 引用块；image → 占位链接；
 *  - 图片只留占位链接（附件本体走 OPFS，不内嵌）。
 *  - Wave20 块嵌入 → 引用块：> 嵌入自「画布名」+ > [[标题快照]]（不复制对方正文）。
 */

/** docToMarkdown 可选解析上下文：嵌入导出时补全目标画布名（导出管线从 Dexie 注入）。 */
export interface MarkdownExportOptions {
  /** docId → 画布标题（嵌入 caption 用）。 */
  docTitles?: Record<string, string>;
}

function nodeBody(node: BlockNode, opts: MarkdownExportOptions): string {
  const emb = parseDocEmbedData(node.content.data);
  if (emb) {
    const docTitle = opts.docTitles?.[emb.targetDocId] ?? (emb.titleSnapshot || '已删除的画布');
    // 引用块：来源标题 caption + 标题快照双链行。
    return [`> 嵌入自「${docTitle}」`, `> [[${emb.titleSnapshot || emb.targetNodeId}]]`].join('\n');
  }
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

export function docToMarkdown(doc: KBNoteDoc, opts: MarkdownExportOptions = {}): string {
  const tree = buildMainTree(doc.nodes, doc.edges);
  const out: string[] = [`# ${doc.title}`, ''];

  const visit = (nodeId: string, depth: number): void => {
    const node = doc.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const headingLevel = Math.min(depth + 1, 6);
    const body = nodeBody(node, opts);

    if (node.type === 'todo') {
      out.push(`- [${node.todo?.checked ? 'x' : ' '}] ${body.replace(/\n+/g, ' ')}`);
    } else if (node.type === 'bullet') {
      out.push(`- ${body.replace(/\n+/g, ' ')}`);
    } else {
      // 嵌入块整段已是引用块，直接整体挂出（不再套标题行）。
      if (parseDocEmbedData(node.content.data)) {
        out.push(body, '');
        return;
      }
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

/** 把 Markdown 文本包成 Blob（UTF-8）。不在此处触发下载，由 deliver sink 落盘。 */
export function markdownBlob(text: string, mime = 'text/markdown'): Blob {
  return new Blob([text], { type: `${mime};charset=utf-8` });
}
