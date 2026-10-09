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

/**
 * CJK 友好分词：拉丁/数字按词切；中日韩文字按单字成 token。
 * 否则整段中文会被当成一个 token，子串搜索（如「调研」在「第一步调研」里）命中不了。
 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const words = lower.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    // 拉丁/数字整词成 token；CJK 只按单字成 token（不发整串，否则子串命中不了）。
    const latin = w.replace(/[\u4e00-\u9fff]/g, '');
    if (latin) out.push(latin);
    const cjk = w.match(/[\u4e00-\u9fff]/g);
    if (cjk) out.push(...cjk);
  }
  return out;
}

export type NoteIndex = MiniSearch;

/** MiniSearch 构造参数（buildIndex / 空索引占位 / 分片喂入共用同一形状）。 */
export function createEmptyIndex(): MiniSearch {
  return new MiniSearch({
    fields: ['nodeId', 'body'],
    storeFields: ['nodeId', 'body'],
    searchOptions: { prefix: true, combineWith: 'AND', tokenize },
    tokenize,
  });
}

/** 为整份文档构建索引。 */
export function buildIndex(doc: KBNoteDoc): NoteIndex {
  const ms = createEmptyIndex();
  const docs = doc.nodes.map((n) => ({
    id: n.id,
    nodeId: n.id,
    body: extractPlainText(n.content.data),
  }));
  ms.addAll(docs);
  return ms;
}

/**
 * Wave24：分片喂入索引——立即返回一个空索引占位，节点按 chunkSize 片
 * 在 requestIdleCallback 空隙逐片 addAll（无 rIC 时 setTimeout(0) 兜底）。
 * 2k 块下同步 buildIndex ~865ms 长任务被拆成 ≤30ms 的小片，不再阻塞首帧后
 * 的可交互窗口；onReady 在喂完时回调（同一索引对象）。
 * 返回 cancel()：文档提前切换时取消未跑的分片。
 */
export function feedIndexChunked(
  index: NoteIndex,
  doc: KBNoteDoc,
  onReady: () => void,
  opts?: { chunkSize?: number },
): { cancel: () => void } {
  const size = opts?.chunkSize ?? 60;
  const nodes = doc.nodes;
  let i = 0;
  let cancelled = false;
  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  const step = () => {
    if (cancelled) return;
    const slice = nodes.slice(i, i + size);
    if (slice.length) {
      index.addAll(
        slice.map((n) => ({ id: n.id, nodeId: n.id, body: extractPlainText(n.content.data) })),
      );
    }
    i += size;
    if (i < nodes.length) {
      if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(step, { timeout: 500 });
      else setTimeout(step, 0);
    } else {
      onReady();
    }
  };
  step();
  return { cancel: () => { cancelled = true; } };
}

export interface SearchHit {
  nodeId: string;
  snippet: string;
}

/** 查询索引，返回命中节点 id + 片段。 */
export function searchDocs(index: NoteIndex, query: string): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const results = index.search(q, { prefix: true, combineWith: 'AND', tokenize });
  return results.map((r) => {
    const stored = r as unknown as { nodeId?: string; body?: string };
    return {
      nodeId: stored.nodeId ?? String(r.id),
      snippet: stored.body ?? '',
    };
  });
}
