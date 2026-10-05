import type { BlockNode, KBNoteDoc } from '@drawpaper/core';
import { extractPlainText } from './search-index';
import { db } from './db';

/**
 * 跨文档块目标查询（docRef 提及浮层用）。
 * 只读 Dexie `docs` 表（不改表结构）：扫描当前文档 + 所有已存文档的块标题/正文，
 * 返回可被 `[[...]]` 引用的目标块。异步；防抖由 UI 层（React）负责。
 */

/** 一个可被 [[...]] 引用的目标块。 */
export interface DocRefTarget {
  docId: string;
  nodeId: string;
  docTitle: string;
  /** 块代表标题（heading 取正文，否则取正文前若干字）。 */
  nodeTitle: string;
  /** 命中片段（正文纯文本）。 */
  snippet: string;
}

/** 块的代表标题：取正文纯文本前 18 字，空则「空块」。 */
export function nodeDisplayTitle(node: BlockNode): string {
  const text = extractPlainText(node.content.data).trim();
  if (!text) return '空块';
  return text.length > 18 ? text.slice(0, 18) + '…' : text;
}

/** 把一份文档展开成候选目标块。 */
function docToTargets(doc: KBNoteDoc): DocRefTarget[] {
  return doc.nodes.map((node) => {
    const snippet = extractPlainText(node.content.data);
    return {
      docId: doc.id,
      nodeId: node.id,
      docTitle: doc.title || '未命名画布',
      nodeTitle: nodeDisplayTitle(node),
      snippet,
    };
  });
}

/**
 * 查询跨文档目标块。query 为空时返回最近文档的前若干块（便于直接选）。
 * @param currentDoc  当前打开的文档（可能尚未落库，一并纳入）。
 * @param query       查询词（匹配文档标题 / 块标题 / 正文，大小写不敏感，CJK 子串）。
 * @param limit       上限。
 */
export async function searchDocRefTargets(
  currentDoc: KBNoteDoc | null,
  query: string,
  limit = 20,
): Promise<DocRefTarget[]> {
  const candidates: DocRefTarget[] = [];
  const seenDocs = new Set<string>();

  if (currentDoc) {
    candidates.push(...docToTargets(currentDoc));
    seenDocs.add(currentDoc.id);
  }
  let stored: KBNoteDoc[] = [];
  try {
    stored = await db.docs.orderBy('board.updatedAt').reverse().limit(30).toArray();
  } catch {
    stored = [];
  }
  for (const doc of stored) {
    if (seenDocs.has(doc.id)) continue;
    seenDocs.add(doc.id);
    candidates.push(...docToTargets(doc));
  }

  const q = query.trim().toLowerCase();
  if (!q) return candidates.slice(0, limit);

  const score = (t: DocRefTarget): number => {
    let s = 0;
    if (t.docTitle.toLowerCase().includes(q)) s += 4;
    if (t.nodeTitle.toLowerCase().includes(q)) s += 3;
    if (t.snippet.toLowerCase().includes(q)) s += 1;
    return s;
  };
  return candidates
    .map((t) => ({ t, s: score(t) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.t);
}
