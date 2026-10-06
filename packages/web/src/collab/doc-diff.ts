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
 *
 * Wave14：tags / edge.points / page.pageBreaks 是「寄存器型数组」——不再整体 LWW 覆盖，
 * 而是按元素身份差量成 reg-add / reg-remove（并发加不同项取并集，删除走墓碑）。
 */

function eq(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
}

/** 节点可差量标量字段（tags 除外——走寄存器并集差量）。 */
const NODE_SCALAR_FIELDS = [
  'x', 'y', 'width', 'height', 'parentId', 'pinned', 'locked', 'collapsed', 'type',
] as const;

/** 节点块特有可选字段（存在即差量；消失即 patch:null）。 */
const NODE_OPTIONAL_FIELDS = ['todo', 'image', 'heading', 'bookmark', 'attachment', 'reminder'] as const;

// ---- 寄存器元素身份 key（与 core merge.ts 的 regItemKey 对齐）----
function tagKey(t: unknown): string {
  return `t:${String(t)}`;
}
function pointKey(p: unknown): string {
  const pt = p as { x: number; y: number };
  return `p:${Math.round(pt.x)},${Math.round(pt.y)}`;
}
function pageBreakKey(b: unknown): string {
  const pb = b as { id?: string; at?: number };
  return pb.id ? `b:${pb.id}` : `b:${pb.at}`;
}

/** 计算 prev→next 的并集差量，产出 reg-add / reg-remove op。 */
function regDeltaOps(
  entity: 'node' | 'edge' | 'page',
  entityId: string,
  field: 'tags' | 'points' | 'pageBreaks',
  prevArr: unknown[] | undefined,
  nextArr: unknown[] | undefined,
  keyOf: (item: unknown) => string,
): CollabOp[] {
  const before = prevArr ?? [];
  const after = nextArr ?? [];
  const beforeKeys = new Set(before.map(keyOf));
  const afterKeys = new Set(after.map(keyOf));
  const added = after.filter((it) => !beforeKeys.has(keyOf(it)));
  const removedKeys = before.filter((it) => !afterKeys.has(keyOf(it))).map(keyOf);
  const ops: CollabOp[] = [];
  if (added.length > 0) {
    ops.push({ kind: 'reg-add', entity, entityId, field, items: added });
  }
  if (removedKeys.length > 0) {
    ops.push({ kind: 'reg-remove', entity, entityId, field, keys: removedKeys });
  }
  return ops;
}

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
  // points 走寄存器并集差量，不在此整体 diff。
  return Object.keys(patch).length > 0 ? (patch as EdgeFieldPatch) : null;
}

/** 分页设置可差量字段（pageBreaks 除外——走寄存器并集差量）。 */
const PAGE_FIELDS = [
  'orientation', 'marginMm', 'mode', 'showPageBreak', 'colorMode', 'header',
  'footer', 'showPageNumbers', 'edgeLabels', 'pageOrigin',
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
    // tags 寄存器并集差量。
    if (!eq(prevNode.tags, nextNode.tags)) {
      ops.push(...regDeltaOps('node', id, 'tags', prevNode.tags as unknown[], nextNode.tags as unknown[], tagKey));
    }
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
    // points 寄存器并集差量。
    if (!eq(prevEdge.points, nextEdge.points)) {
      ops.push(...regDeltaOps('edge', id, 'points', prevEdge.points as unknown[] | undefined, nextEdge.points as unknown[] | undefined, pointKey));
    }
  }

  // ---- 文档标题 ----
  if (prev.title !== next.title) {
    ops.push({ kind: 'set-doc-meta', patch: { title: next.title } });
  }

  // ---- 分页设置 ----
  const pagePatch = diffPagePatch(prev.page, next.page);
  if (pagePatch) ops.push({ kind: 'set-page', patch: pagePatch });
  // pageBreaks 寄存器并集差量。
  if (!eq(prev.page.pageBreaks, next.page.pageBreaks)) {
    ops.push(...regDeltaOps('page', 'page', 'pageBreaks', prev.page.pageBreaks as unknown[], next.page.pageBreaks as unknown[], pageBreakKey));
  }

  return ops;
}
