import type { BlockNode, Edge, KBNoteDoc } from '@drawpaper/core';
import { extractNodePlainText } from '@drawpaper/core';

/**
 * Wave23 纯键盘跨块父子连线 —— 目标块候选过滤纯函数（零 DOM、零 React、可单测）。
 *
 * 给定当前文档 + 源块 id + 查询词，返回「可被源块连为父」的目标块候选：
 *  - 排除源块自身（自环必然非法，与 core addEdge 自环禁止一致）；
 *  - 排除源块的全部后代（连向后代必成环；core addEdge 会挂起成环冲突弹窗，
 *    这里提前剔除，避免用户选到必然冲突的目标）。
 *
 * 排序稳定（有查询词时）：
 *   tier0 = 标题前缀命中（标题小写 startsWith 查询词）
 *   tier1 = 标题包含（标题小写 includes 查询词，但非前缀）
 *   tier2 = 正文包含（正文小写 includes 查询词，但标题未命中）
 *   同 tier 按 nodeId 字典序 tie-break，保证结果确定性。
 * 查询词为空时：返回全部未被排除的候选（按 doc.nodes 顺序，稳定）。
 */

/** 一个可连为子块的候选目标。 */
export interface ConnectTargetCandidate {
  nodeId: string;
  /** 展示标题（正文纯文本前 18 字，空则「空块」）。 */
  title: string;
  /** 正文纯文本（完整，用于匹配；不展示）。 */
  body: string;
}

/** 被排除项的理由（供单测分支断言）。 */
export type ConnectExclusionReason = 'self' | 'descendant';

export interface ConnectExcluded {
  nodeId: string;
  reason: ConnectExclusionReason;
}

/** 标题截断长度（与 doc-ref-search nodeDisplayTitle 一致）。 */
const TITLE_MAX = 18;

/** 块展示标题：取正文纯文本前 18 字，空则「空块」。 */
export function connectTargetTitle(node: BlockNode): string {
  const text = extractNodePlainText(node.content.data).trim();
  if (!text) return '空块';
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX) + '…' : text;
}

/**
 * 收集 sourceId 的全部后代 id（沿父子边 source→target 向下 BFS，带 visited 防环）。
 * 注意：这里直接扫边图（而非主树裁决结果），因为「连向后代必成环」是图语义，
 * 多父节点只要有一条从 source 可达的路径就应被排除。
 */
export function collectDescendantIds(edges: Edge[], sourceId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const e of edges) {
    if (e.source === e.target) continue; // 自环不参与
    const arr = children.get(e.source) ?? [];
    arr.push(e.target);
    children.set(e.source, arr);
  }
  const out = new Set<string>();
  const stack = [sourceId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.add(cur);
    for (const c of children.get(cur) ?? []) stack.push(c);
  }
  // 不含源自身：调用方决定是否把自身计入排除。
  out.delete(sourceId);
  return out;
}

/**
 * 列出全部候选 + 被排除项（含理由）。不做查询过滤。
 * 源块不在文档中时：无 self/descendant 排除，返回全部节点为候选（防御性分支）。
 */
export function listConnectCandidates(
  doc: Pick<KBNoteDoc, 'nodes' | 'edges'>,
  sourceId: string,
): { candidates: ConnectTargetCandidate[]; excluded: ConnectExcluded[] } {
  const nodeIds = new Set(doc.nodes.map((n) => n.id));
  const descendants = nodeIds.has(sourceId) ? collectDescendantIds(doc.edges, sourceId) : new Set<string>();

  const candidates: ConnectTargetCandidate[] = [];
  const excluded: ConnectExcluded[] = [];

  for (const node of doc.nodes) {
    if (node.id === sourceId) {
      excluded.push({ nodeId: node.id, reason: 'self' });
      continue;
    }
    if (descendants.has(node.id)) {
      excluded.push({ nodeId: node.id, reason: 'descendant' });
      continue;
    }
    candidates.push({
      nodeId: node.id,
      title: connectTargetTitle(node),
      body: extractNodePlainText(node.content.data),
    });
  }

  return { candidates, excluded };
}

/** 匹配 tier（越小越优先）；不命中返回 -1。 */
function matchTier(c: ConnectTargetCandidate, q: string): number {
  const title = c.title.toLowerCase();
  const body = c.body.toLowerCase();
  if (title.startsWith(q)) return 0;
  if (title.includes(q)) return 1;
  if (body.includes(q)) return 2;
  return -1;
}

/**
 * 给定 doc/sourceId/query，返回过滤 + 稳定排序后的候选列表。
 * 空查询：返回全部未排除候选（doc.nodes 顺序）。
 */
export function filterConnectTargets(
  doc: Pick<KBNoteDoc, 'nodes' | 'edges'>,
  sourceId: string,
  query: string,
): ConnectTargetCandidate[] {
  const { candidates } = listConnectCandidates(doc, sourceId);
  const q = query.trim().toLowerCase();
  if (!q) return candidates;

  return candidates
    .map((c) => ({ c, tier: matchTier(c, q) }))
    .filter((x) => x.tier >= 0)
    .sort((a, b) => a.tier - b.tier || a.c.nodeId.localeCompare(b.c.nodeId))
    .map((x) => x.c);
}
