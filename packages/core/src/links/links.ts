import type { BlockNode, DocRefLink, KBNoteDoc } from '../model/index.js';
import { DOCREF_MARK_NAME, LINK_ID_PREFIX } from '../model/index.js';

/**
 * 跨文档 [[双向链接]] 纯函数层（core，零 DOM、零 tiptap 依赖）。
 *
 * 主存 = 块 Tiptap 正文中的 `docRef` mark；本模块负责：
 *  - 从 Tiptap JSON 内容抽取规范化 DocRefLink（稳定 id，重建不 churn）；
 *  - 跨文档反链索引；
 *  - 悬挂链接分类（目标文档缺失 / 目标块缺失）；
 *  - 删除文档 / 块前的影响分析。
 *
 * core 只做 JSON 树遍历，不 import @tiptap/*。
 */

/** FNV-1a 32bit → base36 短串（确定性，无需外部依赖）。 */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * 由四元组派生稳定链接 id（`ln_` + 短哈希）。
 * 同一 (sourceDoc, sourceNode, targetDoc, targetNode) 每次重建都得到相同 id，
 * 因此 createdAt 可在重建时从旧 links 保留，不产生 churn。
 */
export function deriveLinkId(
  sourceDocId: string,
  sourceNodeId: string,
  targetDocId: string,
  targetNodeId: string,
): string {
  return LINK_ID_PREFIX + hashString([sourceDocId, sourceNodeId, targetDocId, targetNodeId].join('|'));
}

/** docRef mark 在 Tiptap JSON 中的宽松形状。 */
interface DocRefMarkJson {
  type?: string;
  attrs?: { targetDocId?: unknown; targetNodeId?: unknown; targetTitle?: unknown };
}

/** 一条抽取自某块的候选链接（尚未去重/补元数据）。 */
interface RawLink {
  targetDocId: string;
  targetNodeId: string;
  targetTitle: string;
}

/** 递归遍历 Tiptap JSON 树，收集某块内全部 docRef mark。 */
function collectMarks(node: unknown, out: RawLink[]): void {
  if (!node || typeof node !== 'object') return;
  const n = node as { marks?: unknown; content?: unknown };
  if (Array.isArray(n.marks)) {
    for (const m of n.marks as DocRefMarkJson[]) {
      if (m?.type !== DOCREF_MARK_NAME || !m.attrs) continue;
      const targetDocId = m.attrs.targetDocId;
      const targetNodeId = m.attrs.targetNodeId;
      if (typeof targetDocId !== 'string' || typeof targetNodeId !== 'string' || !targetDocId || !targetNodeId) {
        continue;
      }
      out.push({
        targetDocId,
        targetNodeId,
        targetTitle: typeof m.attrs.targetTitle === 'string' ? m.attrs.targetTitle : '',
      });
    }
  }
  if (Array.isArray(n.content)) for (const child of n.content) collectMarks(child, out);
}

export interface ExtractOptions {
  /** 旧 links（按稳定 id 保留 createdAt）。 */
  existingLinks?: readonly DocRefLink[];
  /** 时钟注入（默认 Date.now）。 */
  now?: () => number;
}

/**
 * 扫描文档全部块的 Tiptap 正文，抽取 docRef mark → 规范化 DocRefLink[]。
 * - 同一块内重复指向同一目标只产生一条（按四元组去重）。
 * - id 由四元组派生，稳定；createdAt 命中旧 links 则保留，否则用时钟。
 * - targetTitle 取最新 mark 上的快照（重命名后下次重建即刷新）。
 */
export function extractDocLinks(
  sourceDocId: string,
  nodes: readonly BlockNode[],
  opts: ExtractOptions = {},
): DocRefLink[] {
  const existingById = new Map<string, DocRefLink>();
  for (const l of opts.existingLinks ?? []) existingById.set(l.id, l);

  const seen = new Map<string, DocRefLink>();
  const raw: RawLink[] = [];
  for (const node of nodes) {
    raw.length = 0;
    collectMarks(node.content.data, raw);
    for (const r of raw) {
      const id = deriveLinkId(sourceDocId, node.id, r.targetDocId, r.targetNodeId);
      if (seen.has(id)) {
        // 同一目标重复：刷新 title 为最新快照。
        const prev = seen.get(id)!;
        seen.set(id, { ...prev, targetTitle: r.targetTitle || prev.targetTitle });
        continue;
      }
      const old = existingById.get(id);
      seen.set(id, {
        id,
        sourceDocId,
        sourceNodeId: node.id,
        targetDocId: r.targetDocId,
        targetNodeId: r.targetNodeId,
        targetTitle: r.targetTitle,
        createdAt: old?.createdAt ?? (opts.now ? opts.now() : Date.now()),
      });
    }
  }
  return [...seen.values()];
}

/** 反链索引键：目标文档::目标块。 */
export function backlinkKey(targetDocId: string, targetNodeId: string): string {
  return `${targetDocId}::${targetNodeId}`;
}

/**
 * 跨文档反链索引：把 docs[] 里所有 links 聚合为
 * `targetDocId::targetNodeId → 来源链接列表`。
 * 查询某块被谁引用：`byTarget.get(backlinkKey(docId, nodeId)) ?? []`。
 */
export function buildBacklinkIndex(docs: readonly KBNoteDoc[]): Map<string, DocRefLink[]> {
  const byTarget = new Map<string, DocRefLink[]>();
  for (const doc of docs) {
    for (const link of doc.links ?? []) {
      const key = backlinkKey(link.targetDocId, link.targetNodeId);
      const arr = byTarget.get(key);
      if (arr) arr.push(link);
      else byTarget.set(key, [link]);
    }
  }
  return byTarget;
}

/** 悬挂链接：目标文档缺失或目标块缺失。 */
export type DanglingReason = 'doc-missing' | 'node-missing';
export interface DanglingLink {
  link: DocRefLink;
  reason: DanglingReason;
}

/**
 * 报告悬挂链接：
 *  - targetDocId 在 docs 集合中不存在 → 'doc-missing'
 *  - 文档存在但 targetNodeId 不在其 nodes 中 → 'node-missing'
 * docs 传入「现存文档全集」（用 id 索引）。
 */
export function findDanglingLinks(
  links: readonly DocRefLink[],
  docs: readonly KBNoteDoc[],
): DanglingLink[] {
  const docsById = new Map<string, KBNoteDoc>();
  for (const d of docs) docsById.set(d.id, d);
  const out: DanglingLink[] = [];
  for (const link of links) {
    const targetDoc = docsById.get(link.targetDocId);
    if (!targetDoc) {
      out.push({ link, reason: 'doc-missing' });
      continue;
    }
    const exists = targetDoc.nodes.some((n) => n.id === link.targetNodeId);
    if (!exists) out.push({ link, reason: 'node-missing' });
  }
  return out;
}

/** 删除某文档 / 块时受影响的链接分组。 */
export interface AffectedLinks {
  /** 从被删对象出发的出链（将随删除消失）。 */
  outgoing: DocRefLink[];
  /** 指向被删对象的入链（删除后变悬挂，记录保留不丢）。 */
  incoming: DocRefLink[];
}

/** 删除一份文档前：列出出链 + 指向它的入链。 */
export function linksAffectedByDeleteDoc(docId: string, links: readonly DocRefLink[]): AffectedLinks {
  const outgoing: DocRefLink[] = [];
  const incoming: DocRefLink[] = [];
  for (const l of links) {
    if (l.sourceDocId === docId) outgoing.push(l);
    else if (l.targetDocId === docId) incoming.push(l);
  }
  return { outgoing, incoming };
}

/** 删除某块前：列出从该块出发的出链 + 指向该块的入链。 */
export function linksAffectedByDeleteNode(
  docId: string,
  nodeId: string,
  links: readonly DocRefLink[],
): AffectedLinks {
  const outgoing: DocRefLink[] = [];
  const incoming: DocRefLink[] = [];
  for (const l of links) {
    const out = l.sourceDocId === docId && l.sourceNodeId === nodeId;
    const inc = l.targetDocId === docId && l.targetNodeId === nodeId;
    if (out) outgoing.push(l);
    else if (inc) incoming.push(l);
  }
  return { outgoing, incoming };
}
