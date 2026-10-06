import type { BlockNode, Edge, KBNoteDoc } from '@drawpaper/core';
import type { CollabOp, NodeFieldPatch, EdgeFieldPatch, PagePatch } from '@drawpaper/core';

/**
 * 文档差量 → CollabOp 列表（纯函数）。
 *
 * 本地命令管道是本标签的事实来源；本模块把「上一次广播点」与「当前 doc」做浅差量，
 * 产出可广播、可经 applyOp 重放的最小 op 序列。这样无论哪个 action（addNode/paste/
 * reparent/布局宏/setPage…）改了 doc，都能被观测到，无需逐 action 埋点。
 *
 * 只差量 CollabOp 协议覆盖的字段；doc.layout / viewport / board.updatedAt / links /
 * assetRefs / doc.tags 字典 不广播（属既有边界，见 docs/wave9/collab-multitab.md）。
 */

function eq(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
}

/** 节点可差量字段（与 merge 引擎 seedNodeFields 对齐）。 */
const NODE_SCALAR_FIELDS = [
  'x', 'y', 'width', 'height', 'parentId', 'pinned', 'locked', 'collapsed', 'tags', 'type',
] as const;

/** 节点块特有可选字段（存在即差量；消失即 patch:null）。 */
const NODE_OPTIONAL_FIELDS = ['todo', 'image', 'heading', 'bookmark', 'attachment', 'reminder'] as const;

function diffNodePatch(prev: BlockNode, next: BlockNode): NodeFieldPatch | null {
  const patch: Record<string, unknown> = {};
  for (const f of NODE_SCALAR_FIELDS) {
    if (!eq(prev[f], next[f])) patch[f] = next[f];
  }
  // content 是嵌套对象，单独比。
  if (!eq(prev.content, next.content)) patch.content = next.content;
  // style 浅比（color/bg/border）。
  if (!eq(prev.style, next.style)) patch.style = next.style;
  for (const f of NODE_OPTIONAL_FIELDS) {
    const p = prev[f];
    const n = next[f];
    if (n === undefined) {
      if (p !== undefined) patch[f] = null; // 清除
    } else if (!eq(p, n)) {
      patch[f] = n;
    }
  }
  return Object.keys(patch).length > 0 ? (patch as NodeFieldPatch) : null;
}

function diffEdgePatch(prev: Edge, next: Edge): EdgeFieldPatch | null {
  const patch: Record<string, unknown> = {};
  for (const f of ['source', 'target', 'sourceHandle', 'targetHandle', 'label'] as const) {
    if (prev[f] !== next[f]) patch[f] = next[f];
  }
  if (prev.style.color !== next.style.color) patch.color = next.style.color;
  const pPoints = prev.points;
  const nPoints = next.points;
  if (!eq(pPoints, nPoints)) patch.points = nPoints === undefined ? null : nPoints;
  return Object.keys(patch).length > 0 ? (patch as EdgeFieldPatch) : null;
}

/** 分页设置可差量字段（与 PagePatchSchema 对齐）。 */
const PAGE_FIELDS = [
  'orientation', 'marginMm', 'mode', 'showPageBreak', 'colorMode', 'header',
  'footer', 'showPageNumbers', 'edgeLabels', 'pageBreaks', 'pageOrigin',
] as const;

function diffPagePatch(prev: KBNoteDoc['page'], next: KBNoteDoc['page']): PagePatch | null {
  const patch: Record<string, unknown> = {};
  for (const f of PAGE_FIELDS) {
    if (!eq(prev[f], next[f])) patch[f] = next[f];
  }
  return Object.keys(patch).length > 0 ? (patch as PagePatch) : null;
}

/**
 * 差量 prev → next。返回需要广播的 op 序列（尚未打包信封，opId/lamport 由管理器填）。
 * 无变化返回空数组。
 */
export function diffDocOps(prev: KBNoteDoc, next: KBNoteDoc): CollabOp[] {
  const ops: CollabOp[] = [];

  // ---- 节点 ----
  const prevNodes = new Map(prev.nodes.map((n) => [n.id, n]));
  const nextNodes = new Map(next.nodes.map((n) => [n.id, n]));

  const removedIds: string[] = [];
  for (const id of prevNodes.keys()) {
    if (!nextNodes.has(id)) removedIds.push(id);
  }
  if (removedIds.length > 0) ops.push({ kind: 'delete-nodes', nodeIds: removedIds });

  for (const [id, nextNode] of nextNodes) {
    const prevNode = prevNodes.get(id);
    if (!prevNode) {
      ops.push({ kind: 'add-node', node: nextNode });
      continue;
    }
    const patch = diffNodePatch(prevNode, nextNode);
    if (patch) ops.push({ kind: 'update-node', nodeId: id, patch });
  }

  // ---- 边 ----
  const prevEdges = new Map(prev.edges.map((e) => [e.id, e]));
  const nextEdges = new Map(next.edges.map((e) => [e.id, e]));

  for (const id of prevEdges.keys()) {
    if (!nextEdges.has(id)) ops.push({ kind: 'delete-edge', edgeId: id });
  }
  for (const [id, nextEdge] of nextEdges) {
    const prevEdge = prevEdges.get(id);
    if (!prevEdge) {
      ops.push({ kind: 'add-edge', edge: nextEdge });
      continue;
    }
    const patch = diffEdgePatch(prevEdge, nextEdge);
    if (patch) ops.push({ kind: 'update-edge', edgeId: id, patch });
  }

  // ---- 文档标题 ----
  if (prev.title !== next.title) {
    ops.push({ kind: 'set-doc-meta', patch: { title: next.title } });
  }

  // ---- 分页设置 ----
  const pagePatch = diffPagePatch(prev.page, next.page);
  if (pagePatch) ops.push({ kind: 'set-page', patch: pagePatch });

  return ops;
}
