import type { Edge } from '@drawpaper/core';

/**
 * graph-trace.ts —— 画布侧自包含的图遍历（纯函数，不依赖 core/graph）。
 *
 * 模型约定：edge.source = 父、edge.target = 子（与 .kbnote 一致）。
 * 这些遍历供「悬停高亮逻辑链」「聚焦分支子树」「筛选集合」消费，
 * 全部无 DOM/无 React 依赖，可单测。
 */

/** 邻接表：每个节点的出边（父→子）与入边（子→父）。 */
function buildAdjacency(edges: Edge[]): {
  children: Map<string, string[]>;
  parents: Map<string, string[]>;
} {
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const e of edges) {
    children.set(e.source, [...(children.get(e.source) ?? []), e.target]);
    parents.set(e.target, [...(parents.get(e.target) ?? []), e.source]);
  }
  return { children, parents };
}

/**
 * 连通集合（不看边方向）：从 nodeId 出发沿任意边可达的全部节点（含自身）。
 * 用于「悬停一条边/节点高亮整条逻辑链」——其余节点降透明度。
 */
export function collectConnectedSet(edges: Edge[], nodeId: string): Set<string> {
  const { children, parents } = buildAdjacency(edges);
  const seen = new Set<string>([nodeId]);
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of children.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
    for (const next of parents.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/**
 * 聚焦集合：nodeId 自身 + 祖先链（沿父边反向到根的全部祖先）+
 * 后代子树（沿父边正向的全部后代）。
 * 用于 api.focusNodeId：非聚焦节点降透明度/隐藏。
 */
export function collectFocusSet(edges: Edge[], nodeId: string): Set<string> {
  const { children, parents } = buildAdjacency(edges);
  const seen = new Set<string>([nodeId]);

  // 后代子树（正向）
  const down = [nodeId];
  while (down.length) {
    const cur = down.pop()!;
    for (const c of children.get(cur) ?? []) {
      if (!seen.has(c)) {
        seen.add(c);
        down.push(c);
      }
    }
  }
  // 祖先链（反向，全部祖先而非仅一条路径）
  const up = [nodeId];
  while (up.length) {
    const cur = up.pop()!;
    for (const p of parents.get(cur) ?? []) {
      if (!seen.has(p)) {
        seen.add(p);
        up.push(p);
      }
    }
  }
  return seen;
}

/**
 * 一条边的高亮集合：其两端节点的连通集合并集（悬停某条边时高亮整条链）。
 */
export function collectEdgeChain(edges: Edge[], edgeId: string): Set<string> {
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge) return new Set();
  const a = collectConnectedSet(edges, edge.source);
  const b = collectConnectedSet(edges, edge.target);
  return new Set([...a, ...b]);
}

/**
 * 手动钉住/手动移动过的节点集合（增量整理）：layoutPreview 中跳过这些节点，
 * 不画 ghost（避免手动微调被整理预览覆盖）。
 */
export function applyManualFixed(
  ghosts: Record<string, { x: number; y: number; width: number; height: number }>,
  manualFixed: ReadonlySet<string>,
): Record<string, { x: number; y: number; width: number; height: number }> {
  const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const [id, g] of Object.entries(ghosts)) {
    if (!manualFixed.has(id)) out[id] = g;
  }
  return out;
}
