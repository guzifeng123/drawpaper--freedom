import type { LayoutResult } from '../layout/index.js';
import type { PageSettings } from '../model/index.js';
import type { MeasuredSize } from '../layout/index.js';

/**
 * paginate 模块：A4 分页「视图模型」契约（纯逻辑，UI 只负责渲染）。
 * 实现留 TODO（Wave1-B）。
 */

/** 跨页续接标记：一条边跨页时，在两页各画一个同编号小圆圈，表示「见下页 N」。 */
export interface ContinuationMarker {
  /** 成对编号（同一逻辑边在两页的 marker 共享同一个 token）。 */
  token: string;
  edgeId: string;
  /** 出现在哪一页。 */
  pageIndex: number;
  /** 在该页上的落点（相对页面内容区坐标 px）。 */
  x: number;
  y: number;
  /** 指向对端：对端在第几页。 */
  peerPageIndex: number;
}

/** 孤块警告：与主体分离、被排到单独页/或溢出裁切的块。 */
export interface OrphanWarning {
  nodeId: string;
  /** 警告级别。 */
  severity: 'warn' | 'error';
  message: string;
}

/** 一页 A4 的视图模型。 */
export interface PageSheet {
  /** 从 0 开始。 */
  index: number;
  /** 该页内容区在世界坐标中的覆盖矩形（左上 + 尺寸，px）。 */
  worldRect: { x: number; y: number; width: number; height: number };
  /** 落在本页上的节点 id。 */
  nodeIds: string[];
  /** 本页上绘制的边 id（整段落在本页的）。 */
  edgeIds: string[];
  /** 跨页续接标记（成对）。 */
  continuations: ContinuationMarker[];
  /** 适页模式下本页的缩放比例（fit 用）。 */
  scale: number;
}

/** 分页器总输出。 */
export interface PaginateResult {
  pages: PageSheet[];
  orphans: OrphanWarning[];
  /** 文档总页数。 */
  totalPages: number;
}

/** 分页器输入。 */
export interface PaginateInput {
  /** 布局结果（节点落点）。 */
  layout: LayoutResult;
  /** 块实测尺寸。 */
  measured: Record<string, MeasuredSize>;
  /** A4 分页设置。 */
  settings: PageSettings;
  /** 仅导出该分支（node id 集合），缺省导出全部。 */
  scopeNodeIds?: string[];
}

/**
 * Fit：适应一页。
 * 算内容包围盒，等比缩放铺满单页；超出则平铺多页。
 * 【TODO wave1-b】
 */
export function paginateFit(_input: PaginateInput): PaginateResult {
  throw new Error('not implemented: wave1 (paginateFit)');
}

/**
 * Tiles：画布分页。
 * 保留空间布局，按 A4 矩形网格切页，相邻页留 10mm 重叠带；
 * 跨页块整体移到下一页，跨页连线绘制成对续接标记（同编号小圆圈）。
 * 【TODO wave1-b】
 */
export function paginateTiles(_input: PaginateInput): PaginateResult {
  throw new Error('not implemented: wave1 (paginateTiles)');
}

/**
 * Flow：文档重排。
 * 树按深度转打印流（根=大标题，逐级标题/缩进，正文换行），块绝不跨页截断，
 * 支持孤行/标题随行。
 * 【TODO wave1-b】
 */
export function paginateFlow(_input: PaginateInput): PaginateResult {
  throw new Error('not implemented: wave1 (paginateFlow)');
}
