import type { KBNoteDoc } from '@drawpaper/core';
import { buildBacklinkIndex, backlinkKey, findDanglingLinks } from '@drawpaper/core';
import { db } from './db';
import { extractPlainText } from './search-index';

/**
 * 反链查询（BacklinksPanel 用）：从 Dexie 加载全部文档，
 * 用 core 的 buildBacklinkIndex 聚合，返回指向目标文档/块的来源条目。
 */

export interface BacklinkEntry {
  linkId: string;
  sourceDocId: string;
  sourceDocTitle: string;
  sourceNodeId: string;
  sourceNodeTitle: string;
  targetDocId: string;
  targetNodeId: string;
  /** 目标已删（悬挂）。 */
  dangling: boolean;
}

function nodeTitle(node: { content: { data: unknown } }): string {
  const t = extractPlainText(node.content.data).trim();
  return t ? (t.length > 18 ? t.slice(0, 18) + '…' : t) : '空块';
}

/** 加载全部文档（当前文档可能未入库，合并传入）。 */
async function loadAllDocs(currentDoc: KBNoteDoc | null): Promise<KBNoteDoc[]> {
  let stored: KBNoteDoc[] = [];
  try {
    stored = await db.docs.orderBy(':id').toArray();
  } catch {
    stored = [];
  }
  if (!currentDoc) return stored;
  const idx = stored.findIndex((d) => d.id === currentDoc.id);
  if (idx >= 0) stored[idx] = currentDoc;
  else stored.unshift(currentDoc);
  return stored;
}

/**
 * 查询指向 (targetDocId, targetNodeId?) 的反链。
 * targetNodeId 为空 = 文档级反链（指向该文档任意块的来源全部列出）。
 */
export async function loadBacklinks(
  currentDoc: KBNoteDoc | null,
  targetDocId: string,
  targetNodeId: string | null,
): Promise<BacklinkEntry[]> {
  const all = await loadAllDocs(currentDoc);
  const index = buildBacklinkIndex(all);
  const dangling = new Set(
    findDanglingLinks(
      all.flatMap((d) => d.links ?? []),
      all,
    ).map((x) => x.link.id),
  );

  const sources = new Map<string, KBNoteDoc>();
  for (const d of all) sources.set(d.id, d);

  const entries: BacklinkEntry[] = [];
  // 遍历所有块目标键：收集指向 targetDoc 的链接。
  for (const [key, links] of index) {
    const [tdoc, tnode] = key.split('::');
    if (tdoc !== targetDocId) continue;
    if (targetNodeId && tnode !== targetNodeId) continue;
    for (const link of links) {
      const srcDoc = sources.get(link.sourceDocId);
      const srcNode = srcDoc?.nodes.find((n) => n.id === link.sourceNodeId);
      if (!srcDoc || !srcNode) continue;
      entries.push({
        linkId: link.id,
        sourceDocId: srcDoc.id,
        sourceDocTitle: srcDoc.title || '未命名画布',
        sourceNodeId: srcNode.id,
        sourceNodeTitle: nodeTitle(srcNode),
        targetDocId: link.targetDocId,
        targetNodeId: link.targetNodeId,
        dangling: dangling.has(link.id),
      });
    }
  }
  return entries;
}

/** 供面板判空：文档级反链键集合（避免每次重算）。 */
export { backlinkKey };
