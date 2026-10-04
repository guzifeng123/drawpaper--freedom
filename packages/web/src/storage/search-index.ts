import MiniSearch from 'minisearch';
import type { KBNoteDoc } from '@drawpaper/core';

/**
 * MiniSearch 本地全文索引：字段 = 块标题 + 节点纯文本。
 * P0 全量重建（doc 变更防抖后整体重建）；增量重建留待后续。
 */

/** 递归提取 Tiptap JSON 的纯文本（标题/段落/列表/待办的 text 节点都覆盖）。 */
export function extractPlainText(tiptapJson: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { text?: unknown; content?: unknown };
    if (typeof n.text === 'string') parts.push(n.text);
    if (Array.isArray(n.content)) for (const child of n.content) walk(child);
  };
  walk(tiptapJson);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export type NoteIndex = MiniSearch;

/** 为整份文档构建索引。 */
export function buildIndex(doc: KBNoteDoc): NoteIndex {
  const ms = new MiniSearch({
    fields: ['nodeId', 'body'],
    storeFields: ['nodeId', 'body'],
    searchOptions: { prefix: true, combineWith: 'AND' },
  });
  const docs = doc.nodes.map((n) => ({
    id: n.id,
    nodeId: n.id,
    body: extractPlainText(n.content.data),
  }));
  ms.addAll(docs);
  return ms;
}

export interface SearchHit {
  nodeId: string;
  snippet: string;
}

/** 查询索引，返回命中节点 id + 片段。 */
export function searchDocs(index: NoteIndex, query: string): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const results = index.search(q, { prefix: true, combineWith: 'AND' });
  return results.map((r) => {
    const stored = r as unknown as { nodeId?: string; body?: string };
    return {
      nodeId: stored.nodeId ?? String(r.id),
      snippet: stored.body ?? '',
    };
  });
}
