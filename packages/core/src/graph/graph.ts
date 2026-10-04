import type { BlockNode, Edge } from '../model/index.js';

/**
 * graph 模块：图分析纯函数（零 DOM）。
 * 边语义：source 是父、target 是子（有向父子树）。
 * 多父/成环不抛错：buildMainTree 仍裁决出一棵（acyclic）生成树，
 * 冲突同时由 detectConflicts / analyzeGraph 报告，交 UI 弹窗裁决。
 */

/** 主树节点（从 edges 推导的有向父子树中的一个节点）。 */
export interface TreeNode {
  nodeId: string;
  parentId: string | null;
  children: string[];
  depth: number;
}

/** 完整主树结构：节点 id → 树节点。 */
export interface MainTree {
  /** 根节点 id 列表（森林时可能 >1；通常一棵）。 */
  roots: string[];
  /** 全部节点在主树中的角色。 */
  nodes: Record<string, TreeNode>;
}

/** 多父冲突结果。一个节点有 ≥2 条入边时记为多父。 */
export interface MultiParentIssue {
  nodeId: string;
  /** 指向该节点的全部入边 id（按 edges 数组顺序）。 */
  parentEdgeIds: string[];
  /** 入边对应的父节点 id（与 parentEdgeIds 对齐）。 */
  parentIds: string[];
}

/** 环冲突结果。 */
export interface CycleIssue {
  /** 构成环的节点 id 序列（闭合环，首尾相同）。 */
  nodeIds: string[];
  /** 环上的边 id（断开其中任一即可破环）。 */
  edgeIds: string[];
}

/** 图分析总结果。 */
export interface GraphAnalysis {
  tree: MainTree;
  /** 多父冲突（需用户裁决主父）。 */
  multiParents: MultiParentIssue[];
  /** 成环冲突（需用户选边断开）。 */
  cycles: CycleIssue[];
  /** 悬空边（端点不存在）id 列表。 */
  danglingEdges: string[];
  /** 游离块：不与任何边相连的孤立节点 id。 */
  orphanNodes: string[];
}

/**
 * 主树裁决建议：多父场景下，建议保留哪条边为主父边、其余边应删除。
 * UI 据此弹窗让用户确认（绝不静默处理）。
 */
export interface MainTreeDecision {
  /** 建议保留为主父的边 id（每个多父节点一条，按 multiParents 顺序）。 */
  keepParentEdgeIds: string[];
  /** 建议删除的其余父子边 id（可撤销 Command 删除）。 */
  dropEdgeIds: string[];
  /** 成环场景下建议断开的边 id。 */
  breakCycleEdgeIds: string[];
}

/**
 * 沿 parent 指针向上追溯：从 start 出发能否到达 target。
 * 用于在「第一条入边 wins」时跳过会形成环的边。
 */
function reachesUpward(start: string, target: string, parentSrc: Record<string, string>): boolean {
  let cur: string | undefined = start;
  const seen = new Set<string>();
  while (cur !== undefined) {
    if (cur === target) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = parentSrc[cur];
  }
  return false;
}

/**
 * 由 nodes + edges 构建主树。
 * 规则：按 edges 数组顺序，target 的第一条「合法入边」成为主父（稳定可复现）；
 * 自环 / 悬空边跳过；若某条边会在 parent 指针上闭合环，则跳过该边（保证树无环）。
 * roots = 无父节点（森林可多根）。多父/成环不抛错，冲突另行报告。
 */
export function buildMainTree(nodes: BlockNode[], edges: Edge[]): MainTree {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const parentSrc: Record<string, string> = {};
  const children: Record<string, string[]> = {};

  for (const edge of edges) {
    if (edge.source === edge.target) continue; // 自环
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue; // 悬空
    if (parentSrc[edge.target] !== undefined) continue; // 已有父，首边 wins
    // 会成环则跳过（保证生成树无环）
    if (reachesUpward(edge.source, edge.target, parentSrc)) continue;
    parentSrc[edge.target] = edge.source;
  }

  // 组装 children
  for (const child of Object.keys(parentSrc)) {
    const parent = parentSrc[child];
    if (parent === undefined) continue;
    const list = children[parent] ?? [];
    list.push(child);
    children[parent] = list;
  }

  const roots = nodes.filter((n) => parentSrc[n.id] === undefined).map((n) => n.id);

  // 初始化每个节点的 TreeNode（depth 稍后 BFS 覆写）
  const treeNodes: Record<string, TreeNode> = {};
  for (const n of nodes) {
    treeNodes[n.id] = {
      nodeId: n.id,
      parentId: parentSrc[n.id] ?? null,
      children: children[n.id] ?? [],
      depth: 0,
    };
  }

  // BFS 算 depth（从 roots 出发，带 visited 防环）
  const queue: { id: string; depth: number }[] = roots.map((r) => ({ id: r, depth: 0 }));
  const visited = new Set<string>();
  while (queue.length > 0) {
    const item = queue.shift() as { id: string; depth: number };
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    const tn = treeNodes[item.id];
    if (tn) tn.depth = item.depth;
    for (const c of tn?.children ?? []) {
      if (!visited.has(c)) queue.push({ id: c, depth: item.depth + 1 });
    }
  }

  return { roots, nodes: treeNodes };
}

/** 枚举某节点的整棵子树（含自身，BFS 顺序）。 */
export function enumerateSubtree(tree: MainTree, rootId: string): string[] {
  const out: string[] = [];
  const start = tree.nodes[rootId];
  if (!start) return out;
  const queue: string[] = [rootId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const tn = tree.nodes[id];
    if (tn) queue.push(...tn.children);
  }
  return out;
}

/** 并查集：忽略方向的连通分量。孤立点自成分量。 */
export function connectedComponents(nodes: BlockNode[], edges: Edge[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root) as string;
    }
    let cur = x;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const n of nodes) parent.set(n.id, n.id);
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    if (nodeIds.has(e.source) && nodeIds.has(e.target)) union(e.source, e.target);
  }

  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const root = find(n.id);
    const list = groups.get(root) ?? [];
    list.push(n.id);
    groups.set(root, list);
  }
  return [...groups.values()];
}

/** 游离块：不与任何边相连（既非 source 也非 target）的节点。 */
export function findOrphans(nodes: BlockNode[], edges: Edge[]): string[] {
  const referenced = new Set<string>();
  for (const e of edges) {
    referenced.add(e.source);
    referenced.add(e.target);
  }
  return nodes.filter((n) => !referenced.has(n.id)).map((n) => n.id);
}

/**
 * DFS 着色找有向环（自环也算）。返回环上节点序列与边 id。
 * 端点均存在才参与。
 */
function findCycles(nodes: BlockNode[], edges: Edge[]): CycleIssue[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const adj = new Map<string, { to: string; edgeId: string }[]>();
  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    const list = adj.get(e.source) ?? [];
    list.push({ to: e.target, edgeId: e.id });
    adj.set(e.source, list);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);

  const cycles: CycleIssue[] = [];
  const seen = new Set<string>();
  const stack: { node: string; edgeId: string | null }[] = [];
  const onStack = new Map<string, number>();

  const dfs = (u: string, incomingEdgeId: string | null): void => {
    color.set(u, GRAY);
    stack.push({ node: u, edgeId: incomingEdgeId });
    onStack.set(u, stack.length - 1);
    for (const { to, edgeId } of adj.get(u) ?? []) {
      const c = color.get(to) ?? WHITE;
      if (c === GRAY) {
        const idx = onStack.get(to);
        if (idx === undefined) continue;
        const slice = stack.slice(idx);
        const cycleNodes = slice.map((s) => s.node);
        const cycleEdges = slice.slice(1).map((s) => s.edgeId as string);
        cycleEdges.push(edgeId);
        const key = cycleEdges.slice().sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push({ nodeIds: [...cycleNodes, to], edgeIds: cycleEdges });
        }
      } else if (c === WHITE) {
        dfs(to, edgeId);
      }
    }
    stack.pop();
    onStack.delete(u);
    color.set(u, BLACK);
  };

  for (const n of nodes) {
    if (color.get(n.id) === WHITE) dfs(n.id, null);
  }
  return cycles;
}

/**
 * 检测多父与成环。
 * 多父：一个节点入度 > 1（端点存在、非自环）。
 */
export function detectConflicts(
  nodes: BlockNode[],
  edges: Edge[],
): Pick<GraphAnalysis, 'multiParents' | 'cycles'> {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const incoming = new Map<string, { edgeId: string; parentId: string }[]>();

  for (const e of edges) {
    if (e.source === e.target) continue;
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    const list = incoming.get(e.target) ?? [];
    list.push({ edgeId: e.id, parentId: e.source });
    incoming.set(e.target, list);
  }

  const multiParents: MultiParentIssue[] = [];
  for (const [nodeId, list] of incoming) {
    if (list.length > 1) {
      multiParents.push({
        nodeId,
        parentEdgeIds: list.map((x) => x.edgeId),
        parentIds: list.map((x) => x.parentId),
      });
    }
  }

  return { multiParents, cycles: findCycles(nodes, edges) };
}

/** 一次算齐：tree / multiParents / cycles / danglingEdges / orphanNodes。 */
export function analyzeGraph(nodes: BlockNode[], edges: Edge[]): GraphAnalysis {
  const tree = buildMainTree(nodes, edges);
  const { multiParents, cycles } = detectConflicts(nodes, edges);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const danglingEdges = edges
    .filter((e) => !nodeIds.has(e.source) || !nodeIds.has(e.target))
    .map((e) => e.id);
  const orphanNodes = findOrphans(nodes, edges);
  return { tree, multiParents, cycles, danglingEdges, orphanNodes };
}

/**
 * 基于分析结果给出裁决建议：
 * - 每个多父节点：保留首条入边，其余入边进 dropEdgeIds。
 * - 每个环：断开环上最后一条边进 breakCycleEdgeIds。
 */
export function suggestMainTreeDecision(analysis: GraphAnalysis): MainTreeDecision {
  const keepParentEdgeIds: string[] = [];
  const dropEdgeIds: string[] = [];
  for (const mp of analysis.multiParents) {
    const [keep, ...drop] = mp.parentEdgeIds;
    if (keep !== undefined) keepParentEdgeIds.push(keep);
    dropEdgeIds.push(...drop);
  }
  const breakCycleEdgeIds: string[] = analysis.cycles.map(
    (c) => c.edgeIds[c.edgeIds.length - 1] as string,
  );
  return { keepParentEdgeIds, dropEdgeIds, breakCycleEdgeIds };
}

/* ------------------------------------------------------------------ *
 * P1 聚焦 / 逻辑链分析（纯函数，不破坏既有 API）。
 * 供悬停高亮整条逻辑链、聚焦分支视图使用。
 * ------------------------------------------------------------------ */

/**
 * 祖先链：从 nodeId 沿 parent 指针向上追溯到根（含自身）。
 * 返回顺序：[nodeId, parent, grandparent, ..., root]。
 * 节点不在树中时返回空数组；带 visited 防环。
 */
export function getAncestorChain(tree: MainTree, nodeId: string): string[] {
  const out: string[] = [];
  const start = tree.nodes[nodeId];
  if (!start) return out;
  const seen = new Set<string>();
  let cur: string = nodeId;
  for (;;) {
    if (seen.has(cur)) break;
    seen.add(cur);
    out.push(cur);
    const tn: TreeNode | undefined = tree.nodes[cur];
    const parent = tn?.parentId;
    if (parent === null || parent === undefined) break;
    cur = parent;
  }
  return out;
}

/**
 * 后代集合：nodeId 的整棵子树（含自身，BFS 顺序）。
 * 语义同 {@link enumerateSubtree}，命名面向聚焦场景。
 */
export function getDescendantSet(tree: MainTree, nodeId: string): string[] {
  return enumerateSubtree(tree, nodeId);
}

/**
 * 关联链（连通分量）：忽略边方向，返回 nodeId 所在的连通分量全部节点 id（排序）。
 * 用于悬停高亮整条「逻辑链」（跨分支的关联节点一并亮起）。
 * nodeId 孤立时返回 [nodeId]。
 */
export function getRelatedChain(
  nodes: BlockNode[],
  edges: Edge[],
  nodeId: string,
): string[] {
  const comps = connectedComponents(nodes, edges);
  for (const comp of comps) {
    if (comp.includes(nodeId)) return [...comp].sort();
  }
  return [nodeId];
}

/**
 * 聚焦视图集合：聚焦某节点时，应高亮的「分支」与应弱化的「其余节点」。
 * - focus = 祖先链（含自身）∪ 该节点子树（含自身）——即从根到该叶的整条主干 + 该分支。
 * - dim  = 树中其余节点。
 * 结果均按字典序排序，便于确定性 diff / 渲染。
 */
export function getFocusViewSet(
  tree: MainTree,
  nodeId: string,
): { focus: string[]; dim: string[] } {
  const ancestorChain = getAncestorChain(tree, nodeId);
  const subtree = enumerateSubtree(tree, nodeId);
  const focusSet = new Set<string>([...ancestorChain, ...subtree]);
  const focus = [...focusSet].sort();
  const dim = Object.keys(tree.nodes)
    .filter((id) => !focusSet.has(id))
    .sort();
  return { focus, dim };
}
