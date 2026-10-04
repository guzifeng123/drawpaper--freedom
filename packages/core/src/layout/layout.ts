import type { BlockNode, Edge, LayoutMode } from '../model/index.js';

/**
 * layout 模块：树布局 API 签名契约（d3-hierarchy 驱动，纯函数）。
 * 实现留 TODO（Wave1-B），此处冻结类型与签名。
 */

/** 块实测尺寸（由 web 侧 ResizeObserver 注入；布局引擎不自己测）。 */
export interface MeasuredSize {
  width: number;
  height: number;
}

/** 布局冲突/碰撞报告。 */
export interface CollisionReport {
  /** 发生重叠的节点 id 对。 */
  overlappingPairs: Array<[string, string]>;
  /** 被 pinned 阻挡、布局引擎绕行时避让出的最小位移说明。 */
  detouredNodes: string[];
}

/** 单个节点布局落点。 */
export interface LayoutPosition {
  x: number;
  y: number;
}

/** 布局结果：节点 id → 落点坐标（画布世界坐标）。 */
export interface LayoutResult {
  positions: Record<string, LayoutPosition>;
  collisions: CollisionReport;
  /** 人类可读的绕行/碰撞说明（调试/预览用）。 */
  notes: string[];
}

/**
 * 布局输入。
 */
export interface LayoutInput {
  /** 参与布局的节点子集（「仅整理选中分支」时只传该子树）。 */
  nodes: BlockNode[];
  /** 父子边。 */
  edges: Edge[];
  /** 指定根节点 id（缺省由 graph 模块裁决）。 */
  rootId?: string;
  /** 间距偏好。 */
  rankSpacing: number;
  nodeSpacing: number;
  /** 块实测尺寸（id → size）。必须由调用方注入。 */
  measured: Record<string, MeasuredSize>;
  /** pinned 节点集合：布局不移动它们，并为其绕行。 */
  pinned?: ReadonlySet<string>;
  /** collapsedMap：id → 是否折叠；折叠子树收为一个单位，不展开内部。 */
  collapsed?: Readonly<Record<string, boolean>>;
}

/**
 * 树布局入口。
 * @param input  布局输入（节点/边/根/间距/实测/pinned/collapsed）
 * @param mode   P0 ∈ mindmap-right | mindmap-down | org-tree
 *               （'radial' 为 P1 预留，未实现，调用即抛错）
 * @returns LayoutResult：每个节点的世界坐标 + 碰撞报告。
 *
 * 实现约定：内部用 d3-hierarchy 的 tree()，横向/纵向通过交换 x/y 实现；
 * pinned 节点位置不动，其余节点为其预留空间绕行；collapsed 子树不展开。
 * 【TODO wave1-b】
 */
export function layoutTree(_input: LayoutInput, _mode: LayoutMode): LayoutResult {
  throw new Error('not implemented: wave1 (layoutTree)');
}

/**
 * 类型再导出：d3-hierarchy 已在本包安装，可被 import；
 * 实现侧将使用 `hierarchy` / `tree` / `cluster`。此处仅占位以确保依赖存在。
 */
export type { LayoutMode };
