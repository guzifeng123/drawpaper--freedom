import type { BlockNode, Edge } from '../model/index.js';

/**
 * graph 模块：图分析 API 签名契约（纯函数，零 DOM）。
 * 所有实现留 TODO（Wave1-A），此处只冻结「类型 + 签名 + JSDoc 语义」，
 * 保证 layout/store/web 可直接 import 并通过 tsc 编译。
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
  /** 指向该节点的全部入边 id。 */
  parentEdgeIds: string[];
  /** 入边对应的父节点 id（与 parentEdgeIds 对齐）。 */
  parentIds: string[];
}

/** 环冲突结果。 */
export interface CycleIssue {
  /** 构成环的节点 id 序列（闭合环）。 */
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
  /** 悬空边（端点不存在）。 */
  danglingEdges: string[];
  /** 游离块：不在任何主树分支上、无任何边连接的节点 id。 */
  orphanNodes: string[];
}

/**
 * 主树裁决建议：多父场景下，建议保留哪条边为主父边、其余边应删除。
 * UI 据此弹窗让用户确认（绝不静默处理）。
 */
export interface MainTreeDecision {
  /** 建议保留为主父的边 id（每个多父节点一条）。 */
  keepParentEdgeId: string;
  /** 建议删除的其余父子边 id（可撤销 Command 删除）。 */
  dropEdgeIds: string[];
  /** 成环场景下建议断开的边 id。 */
  breakCycleEdgeIds: string[];
}

/**
 * 由 nodes + edges 构建主树。
 * 输入：节点数组、边数组。
 * 输出：MainTree（roots + 每节点 parentId/children/depth）。
 * 语义：边 source→target 表示 source 是父、target 是子。多父/成环时仍按「先到先得 /
 * 边序稳定」裁决出一棵生成树，并把冲突同时放进 multiParents/cycles 供 UI 弹窗。
 * 【TODO wave1-a】
 */
export function buildMainTree(_nodes: BlockNode[], _edges: Edge[]): MainTree {
  throw new Error('not implemented: wave1 (buildMainTree)');
}

/**
 * 枚举某节点的整棵子树（含自身）。
 * 输入：主树、根节点 id。输出：子树全部节点 id（含根）。
 * 【TODO wave1-a】
 */
export function enumerateSubtree(_tree: MainTree, _rootId: string): string[] {
  throw new Error('not implemented: wave1 (enumerateSubtree)');
}

/**
 * 求连通子图（忽略方向，仅按节点是否通过边相连）。
 * 输出：每个连通分量的节点 id 列表。
 * 【TODO wave1-a】
 */
export function connectedComponents(_nodes: BlockNode[], _edges: Edge[]): string[][] {
  throw new Error('not implemented: wave1 (connectedComponents)');
}

/**
 * 游离块：无边连接的孤立节点。
 * 【TODO wave1-a】
 */
export function findOrphans(_nodes: BlockNode[], _edges: Edge[]): string[] {
  throw new Error('not implemented: wave1 (findOrphans)');
}

/**
 * 检测多父与成环。
 * 输出：multiParents + cycles（即 GraphAnalysis 的冲突部分）。
 * 【TODO wave1-a】
 */
export function detectConflicts(_nodes: BlockNode[], _edges: Edge[]): Pick<GraphAnalysis, 'multiParents' | 'cycles'> {
  throw new Error('not implemented: wave1 (detectConflicts)');
}

/**
 * 基于冲突结果给出主树裁决建议（保留哪条父边、删哪些边、断哪条环边）。
 * 【TODO wave1-a】
 */
export function suggestMainTreeDecision(_analysis: GraphAnalysis): MainTreeDecision {
  throw new Error('not implemented: wave1 (suggestMainTreeDecision)');
}
