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
  return linksAffectedByDeleteNodes(docId, new Set([nodeId]), links);
}

/**
 * 删除一批块前（多选删除）：聚合同一文档内多个待删块的影响。
 * 出链 = 源在被删集合内；入链 = 目标在被删集合内。一条链接不会同时命中两侧。
 */
export function linksAffectedByDeleteNodes(
  docId: string,
  nodeIds: ReadonlySet<string>,
  links: readonly DocRefLink[],
): AffectedLinks {
  const outgoing: DocRefLink[] = [];
  const incoming: DocRefLink[] = [];
  for (const l of links) {
    const out = l.sourceDocId === docId && nodeIds.has(l.sourceNodeId);
    const inc = l.targetDocId === docId && nodeIds.has(l.targetNodeId);
    if (out) outgoing.push(l);
    else if (inc) incoming.push(l);
  }
  return { outgoing, incoming };
}

/** Tiptap 文本节点（leaf：有 text、无 content）的宽松形状。 */
interface TextNodeJson {
  type?: string;
  text?: string;
  marks?: DocRefMarkJson[];
  content?: TextNodeJson[];
}

/**
 * 递归遍历 Tiptap JSON 树，对每个「带 marks 的文本叶子」调用 visitTextNode。
 * 文本叶子无 content 子节点（Tiptap 约定）；容器节点递归其 content。
 * visitTextNode 返回新节点表示有改动、返回原引用表示无改动。
 * 无改动的子树/节点共享原引用（结构共享，零拷贝热路径）。
 */
function walkTextNodes(
  node: unknown,
  visitTextNode: (n: TextNodeJson) => TextNodeJson,
): { out: unknown; changed: boolean } {
  if (!node || typeof node !== 'object') return { out: node, changed: false };
  const n = node as TextNodeJson;
  if (typeof n.text === 'string') {
    const v = visitTextNode(n);
    return { out: v, changed: v !== n };
  }
  let changed = false;
  let next: TextNodeJson[] | undefined;
  if (Array.isArray(n.content)) {
    next = new Array(n.content.length);
    for (let i = 0; i < n.content.length; i++) {
      const r = walkTextNodes(n.content[i], visitTextNode);
      next[i] = r.out as TextNodeJson;
      if (r.changed) changed = true;
    }
  }
  return { out: changed ? { ...n, content: next } : n, changed };
}

/** 级联移除 / 重命名变换的结果。 */
export interface NodeTransformResult {
  /** 变换后的新文档（无改动字段共享原引用）。 */
  doc: KBNoteDoc;
  /** 实际被改写的 docRef mark 条数。 */
  count: number;
}

/**
 * 级联移除：从文档全部块正文中摘除「link id 命中待删集合」的 docRef mark。
 *
 * 用途：删除块时用户选「一并移除这些链接」——把指向/发自该块的 mark 从源文档里剥掉。
 * - link id 由 (sourceDocId, sourceNodeId, targetDocId, targetNodeId) 四元组派生，
 *   与 extractDocLinks 派生口径一致，因此影响分析给出的 id 集合可直接命中。
 * - 只摘 mark、保留文本（`[[...]]` 退化为纯文本，不静默吞字）；
 * - 本函数不维护 doc.links：调用方在变换后用 extractDocLinks 重建（与 flushSave 同口径）。
 * - 纯 JSON 树遍历，零 DOM、零 Tiptap 依赖。
 */
export function stripDocRefMarks(
  doc: KBNoteDoc,
  removeLinkIds: ReadonlySet<string>,
): NodeTransformResult {
  let count = 0;
  const nodes = doc.nodes.map((node) => {
    const data = node.content?.data;
    if (!data || typeof data !== 'object') return node;
    const { out, changed } = walkTextNodes(data, (n) => {
      if (!Array.isArray(n.marks)) return n;
      let selfChanged = false;
      const kept: DocRefMarkJson[] = [];
      for (const m of n.marks) {
        if (m?.type === DOCREF_MARK_NAME && m.attrs) {
          const td = m.attrs.targetDocId;
          const tn = m.attrs.targetNodeId;
          if (typeof td === 'string' && typeof tn === 'string' && td && tn) {
            const id = deriveLinkId(doc.id, node.id, td, tn);
            if (removeLinkIds.has(id)) {
              count++;
              selfChanged = true;
              continue;
            }
          }
        }
        kept.push(m);
      }
      if (!selfChanged) return n;
      const clone: TextNodeJson = { ...n };
      if (kept.length > 0) clone.marks = kept;
      else delete clone.marks;
      return clone;
    });
    if (!changed) return node;
    return { ...node, content: { ...node.content, data: out } };
  });
  return { doc: { ...doc, nodes }, count };
}

/**
 * 重命名重索引：目标块改名后，把文档内所有指向 (targetDocId, targetNodeId) 的
 * docRef mark 批量改写：
 * - attrs.targetTitle 始终刷新为新标题（反链索引/悬挂展示的快照来源）；
 * - 若可见文本仍是标准 `[[...]]` 包裹（未被用户自定义改过），同步改写为 `[[新标题]]`，
 *   保证 chip 展示文本与新标题一致；用户改过的自定义文本保持不动。
 *
 * 配合 extractDocLinks：变换后重建 doc.links 即得到刷新过 targetTitle 的反链索引。
 */
export function retitleDocRefMarks(
  doc: KBNoteDoc,
  targetDocId: string,
  targetNodeId: string,
  newTitle: string,
): NodeTransformResult {
  const wrapped = `[[${newTitle}]]`;
  let count = 0;
  const nodes = doc.nodes.map((node) => {
    const data = node.content?.data;
    if (!data || typeof data !== 'object') return node;
    const { out, changed } = walkTextNodes(data, (n) => {
      if (!Array.isArray(n.marks)) return n;
      let selfChanged = false;
      let oldTitle = '';
      const marks = n.marks.map((m) => {
        if (m?.type !== DOCREF_MARK_NAME || !m.attrs) return m;
        if (m.attrs.targetDocId !== targetDocId || m.attrs.targetNodeId !== targetNodeId) return m;
        count++;
        selfChanged = true;
        oldTitle = typeof m.attrs.targetTitle === 'string' ? m.attrs.targetTitle : '';
        return { ...m, attrs: { ...m.attrs, targetTitle: newTitle } };
      });
      if (!selfChanged) return n;
      let text = n.text;
      // 可见文本：把 mark 包裹里的旧标题子串换成新标题（兼容「看 [[旧]]」这类
      // mark 覆盖整段的情形）；旧标题未知或文本已被自定义改过则不动文本。
      if (typeof text === 'string' && oldTitle) {
        text = text.split(`[[${oldTitle}]]`).join(wrapped);
      }
      return { ...n, text, marks };
    });
    if (!changed) return node;
    return { ...node, content: { ...node.content, data: out } };
  });
  return { doc: { ...doc, nodes }, count };
}
