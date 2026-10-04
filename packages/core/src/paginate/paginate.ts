import type { BlockNode, Edge, PageSettings } from '../model/index.js';
import type { LayoutResult, MeasuredSize } from '../layout/index.js';
import { DEFAULT_NODE_SIZE } from '../layout/index.js';
import {
  contentRect,
  mmToPx,
  TILES_OVERLAP_MM,
  FLOW_INDENT_PER_LEVEL,
  FLOW_BLOCK_GAP_PX,
} from './constants.js';

/**
 * paginate 模块：A4 分页「视图模型」（纯逻辑，零 DOM）。
 *
 * 三种排版模式（见 model/page.ts 的 PageMode）：
 *  - fit  ：内容包围盒等比缩放铺满单页（≤2 倍放大；缩到 <0.25 仍放不下时退化为 tiles 网格）。
 *  - tiles：保留空间布局，按 A4 内容区网格切页，相邻页 10mm 重叠带；跨页块整体挪页，
 *           跨页连线成对续接标记（同 token 小圆圈）。
 *  - flow ：DFS 主树转打印流，深度→缩进，块绝不跨页截断，标题/父块随行（widow/orphan）。
 */

/** 跨页续接标记：一条边跨页时，在两页各画一个同编号小圆圈。 */
export interface ContinuationMarker {
  /** 成对编号（同一逻辑边在两页的 marker 共享同一个 token）。 */
  token: string;
  edgeId: string;
  /** 出现在哪一页（page index）。 */
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
  severity: 'warn' | 'error';
  message: string;
}

/** 一页 A4 的视图模型。 */
export interface PageSheet {
  /** 从 0 开始。 */
  index: number;
  /** 与 index 一致（页码，从 1 起的展示值由渲染层 +index 得到）。 */
  pageNumber: number;
  /** 该页内容区在世界坐标中的覆盖矩形（左上 + 尺寸，px）。 */
  worldRect: { x: number; y: number; width: number; height: number };
  /** 落在本页上的节点 id。 */
  nodeIds: string[];
  /** 本页上绘制的边 id（整段落在本页的）。 */
  edgeIds: string[];
  /** 跨页续接标记（成对）。 */
  continuations: ContinuationMarker[];
  /** 适页模式下本页的缩放比例（fit 用；tiles/flow 为 1）。 */
  scale: number;
  /**
   * 节点在本页上的绘制坐标（页面本地 px，已含 scale 与边距）。
   * 原世界坐标不变，渲染层直接据此绘制。
   */
  nodeDrawOffsets?: Record<string, { x: number; y: number }>;
  headerText?: string;
  footerText?: string;
}

/** 分页器总输出。 */
export interface PaginateResult {
  pages: PageSheet[];
  orphans: OrphanWarning[];
  totalPages: number;
  /** 人类可读说明（fit 退化、孤块、折叠剔除等）。 */
  notes: string[];
}

/**
 * 渲染期分页设置（在 model.PageSettings 基础上补充页眉/页脚文本等）。
 * pageOrigin 已在 PageSettings 中定义。
 */
export interface PaginateSettings extends PageSettings {
  headerText?: string;
  footerText?: string;
  showEdgeLabels?: boolean;
  grayScale?: boolean;
}

/** 分页器输入。 */
export interface PaginateInput {
  /** 布局结果（节点落点）。 */
  layout: LayoutResult;
  /** 块实测尺寸。 */
  measured: Record<string, MeasuredSize>;
  /** A4 分页设置。 */
  settings: PaginateSettings;
  /** 仅导出该分支（node id 集合），缺省导出全部。 */
  scopeNodeIds?: string[];
  /** 块节点（flow 建树 / 尺寸兜底用）。 */
  nodes?: BlockNode[];
  /** 父子边（tiles 跨页续接 / flow 建树用）。 */
  edges?: Edge[];
  /** 折叠集合：折叠节点的后代不参与导出（折叠节点自身保留）。 */
  collapsed?: Readonly<Record<string, boolean>>;
  /** flow 模式下对默认实测高的重排覆盖（id → 高 px）。 */
  flowHeights?: Record<string, number>;
}

// ---------- 内部工具 ----------

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function sizeOf(input: PaginateInput, id: string): MeasuredSize {
  return input.measured[id] ?? DEFAULT_NODE_SIZE;
}

/** 由 edges 构建 parentOf（首条入边 wins），只保留 active 内的边。 */
function buildParentOf(edges: Edge[] | undefined, active: Set<string>): Map<string, string> {
  const parentOf = new Map<string, string>();
  for (const e of edges ?? []) {
    if (!active.has(e.source) || !active.has(e.target)) continue;
    if (parentOf.has(e.target)) continue;
    parentOf.set(e.target, e.source);
  }
  return parentOf;
}

/**
 * 计算参与导出的节点集合：scopeNodeIds 过滤 + 折叠后代剔除。
 * 折叠节点自身保留；其后代（沿 parentOf 上溯到折叠祖先者）被剔除。
 */
function activeNodeSet(input: PaginateInput): { active: Set<string>; notes: string[] } {
  const notes: string[] = [];
  const allIds = new Set(Object.keys(input.layout.positions));
  const scope = input.scopeNodeIds ?? [...allIds];
  const active = new Set<string>();
  for (const id of scope) {
    if (allIds.has(id)) active.add(id);
  }
  const parentOf = buildParentOf(input.edges, active);
  // 折叠后代剔除
  const collapsed = input.collapsed ?? {};
  const isFoldedDescendant = (id: string): boolean => {
    let cur = parentOf.get(id);
    while (cur) {
      if (collapsed[cur]) return true;
      cur = parentOf.get(cur);
    }
    return false;
  };
  let foldedCount = 0;
  for (const id of [...active]) {
    if (isFoldedDescendant(id)) {
      active.delete(id);
      foldedCount++;
    }
  }
  if (foldedCount > 0) notes.push(`折叠子树剔除：${foldedCount} 个后代节点不参与导出。`);
  return { active, notes };
}

function nodeRect(input: PaginateInput, id: string): Rect {
  const pos = input.layout.positions[id] ?? { x: 0, y: 0 };
  const size = sizeOf(input, id);
  return { x: pos.x, y: pos.y, width: size.width, height: size.height };
}

/** 计算 active 节点的世界包围盒。 */
function contentBBox(input: PaginateInput, active: Set<string>): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of active) {
    const r = nodeRect(input, id);
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 把页面矩形按行序编号（j*cols+i）生成 PageSheet 骨架。 */
function makePageSheet(
  index: number,
  worldRect: Rect,
  scale: number,
  settings: PaginateSettings,
): PageSheet {
  return {
    index,
    pageNumber: index,
    worldRect,
    nodeIds: [],
    edgeIds: [],
    continuations: [],
    scale,
    nodeDrawOffsets: {},
    headerText: settings.headerText,
    footerText: settings.footerText,
  };
}

// ---------- fit ----------

/**
 * Fit：适应一页。
 * 算内容包围盒，等比缩放铺满单页；允许 ≤2 倍放大；
 * 当自然 scale<0.25 仍放不下时退化为固定 0.25 的 tiles 网格（notes 说明）。
 */
export function paginateFit(input: PaginateInput): PaginateResult {
  const notes: string[] = [];
  const { active, notes: aNotes } = activeNodeSet(input);
  notes.push(...aNotes);
  const cr = contentRect({
    orientation: input.settings.orientation,
    marginMm: input.settings.marginMm,
    header: input.settings.header,
    footer: input.settings.footer,
  });

  if (active.size === 0) {
    const sheet = makePageSheet(0, { x: 0, y: 0, width: cr.width, height: cr.height }, 1, input.settings);
    return { pages: [sheet], orphans: [], totalPages: 1, notes };
  }

  const bbox = contentBBox(input, active);
  const bw = bbox.width;
  const bh = bbox.height;
  const naturalScale = Math.min(cr.width / bw, cr.height / bh);

  // 退化：自然 scale 不足 0.25 → 以固定 0.25 铺 tiles 网格。
  if (naturalScale < 0.25) {
    notes.push(
      `fit 退化：自然缩放 ${naturalScale.toFixed(3)} < 0.25，按固定 scale=0.25 平铺多页（见 tiles 网格）。`,
    );
    const tiles = runTilesGrid(input, active, cr, 0.25, { x: bbox.x, y: bbox.y }, notes);
    return { pages: tiles.pages, orphans: tiles.orphans, totalPages: tiles.pages.length, notes };
  }

  const scale = Math.min(naturalScale, 2);
  // 内容在页面上居中。
  const offsetX = cr.x + (cr.width - bw * scale) / 2;
  const offsetY = cr.y + (cr.height - bh * scale) / 2;

  const sheet = makePageSheet(0, bbox, scale, input.settings);
  for (const id of active) {
    const r = nodeRect(input, id);
    sheet.nodeIds.push(id);
    sheet.nodeDrawOffsets![id] = {
      x: offsetX + (r.x - bbox.x) * scale,
      y: offsetY + (r.y - bbox.y) * scale,
    };
  }
  sheet.nodeIds.sort();

  // 边：单页模式下所有 active 边整段绘制。
  for (const e of input.edges ?? []) {
    if (active.has(e.source) && active.has(e.target)) sheet.edgeIds.push(e.id);
  }
  sheet.edgeIds.sort();

  return { pages: [sheet], orphans: [], totalPages: 1, notes };
}

// ---------- tiles（fit 退化与 tiles 模式共用网格逻辑） ----------

/**
 * 以 (origin) 为世界起点，按「scale 下一页内容区」大小铺网格。
 * @param scale 该网格下的缩放（tiles=1，fit 退化=0.25）。
 */
function runTilesGrid(
  input: PaginateInput,
  active: Set<string>,
  cr: ReturnType<typeof contentRect>,
  scale: number,
  origin: { x: number; y: number },
  notes: string[],
): { pages: PageSheet[]; orphans: OrphanWarning[] } {
  const orphans: OrphanWarning[] = [];

  // 一页在世界坐标里覆盖的范围。
  const pageWorldW = cr.width / scale;
  const pageWorldH = cr.height / scale;
  const overlapWorld = mmToPx(TILES_OVERLAP_MM) / scale;
  const stepX = pageWorldW - overlapWorld;
  const stepY = pageWorldH - overlapWorld;

  const bbox = contentBBox(input, active);
  // 网格行列数：覆盖 bbox。
  const spanX = bbox.x + bbox.width - origin.x;
  const spanY = bbox.y + bbox.height - origin.y;
  const cols = Math.max(1, Math.ceil((spanX + overlapWorld) / stepX));
  const rows = Math.max(1, Math.ceil((spanY + overlapWorld) / stepY));

  // 建页骨架（行序 j*cols+i）。
  const pages: PageSheet[] = [];
  const pageOriginWorld: Array<{ x: number; y: number }> = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const ox = origin.x + i * stepX;
      const oy = origin.y + j * stepY;
      pageOriginWorld.push({ x: ox, y: oy });
      pages.push(
        makePageSheet(pages.length, { x: ox, y: oy, width: pageWorldW, height: pageWorldH }, scale, input.settings),
      );
    }
  }

  // 节点归属：按包围盒中心找页；跨边界整体挪到下一页。
  const nodePageIdx = new Map<string, number>();
  for (const id of active) {
    const r = nodeRect(input, id);
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    let i = Math.floor((cx - origin.x) / stepX);
    let j = Math.floor((cy - origin.y) / stepY);
    i = Math.min(Math.max(i, 0), cols - 1);
    j = Math.min(Math.max(j, 0), rows - 1);

    // 跨边界整体挪到下一页（横向越界向右挪、纵向越界向下挪）。
    const ox = origin.x + i * stepX;
    const oy = origin.y + j * stepY;
    if (r.x + r.width > ox + pageWorldW && i < cols - 1) i += 1;
    if (r.y + r.height > oy + pageWorldH && j < rows - 1) j += 1;

    const pageIdx = j * cols + i;
    const page = pages[pageIdx]!;
    page.nodeIds.push(id);
    const po = pageOriginWorld[pageIdx]!;
    page.nodeDrawOffsets![id] = {
      x: cr.x + (r.x - po.x) * scale,
      y: cr.y + (r.y - po.y) * scale,
    };
    nodePageIdx.set(id, pageIdx);

    // 挪完仍超出单页 → 孤块警告。
    const r2 = nodeRect(input, id);
    if (r2.width > pageWorldW || r2.height > pageWorldH) {
      orphans.push({
        nodeId: id,
        severity: 'warn',
        message: `节点「${id}」大于单页内容区，无法完整落在一页内。`,
      });
    }
  }
  for (const p of pages) p.nodeIds.sort();

  // 边：同页整段绘制；跨页生成成对续接标记。
  for (const e of input.edges ?? []) {
    if (!active.has(e.source) || !active.has(e.target)) continue;
    const ps = nodePageIdx.get(e.source);
    const pt = nodePageIdx.get(e.target);
    if (ps === undefined || pt === undefined) continue;
    if (ps === pt) {
      pages[ps]!.edgeIds.push(e.id);
      continue;
    }
    // 跨页：两端各一个 marker。
    const token = `cont:${e.id}`;
    const srcR = nodeRect(input, e.source);
    const tgtR = nodeRect(input, e.target);
    addContinuation(pages[ps]!, token, e.id, ps, pt, srcR, pageOriginWorld[ps]!, cr, scale);
    addContinuation(pages[pt]!, token, e.id, pt, ps, tgtR, pageOriginWorld[pt]!, cr, scale);
  }
  for (const p of pages) p.edgeIds.sort();

  notes.push(`tiles 网格：${cols} 列 × ${rows} 行，共 ${pages.length} 页。`);
  return { pages, orphans };
}

function addContinuation(
  page: PageSheet,
  token: string,
  edgeId: string,
  pageIndex: number,
  peerPageIndex: number,
  endpointWorld: Rect,
  pageOriginWorld: { x: number; y: number },
  cr: ReturnType<typeof contentRect>,
  scale: number,
): void {
  // 端点换算到页面本地，再夹到内容区边界附近。
  const lx = cr.x + (endpointWorld.x - pageOriginWorld.x) * scale;
  const ly = cr.y + (endpointWorld.y - pageOriginWorld.y) * scale;
  const clampedX = Math.min(Math.max(lx, cr.x), cr.x + cr.width);
  const clampedY = Math.min(Math.max(ly, cr.y), cr.y + cr.height);
  page.continuations.push({ token, edgeId, pageIndex, x: clampedX, y: clampedY, peerPageIndex });
}

/**
 * Tiles：画布分页。
 * 保留空间布局，按 A4 内容区网格切页，相邻页留 10mm 重叠带；
 * 跨页块整体移到下一页，跨页连线绘制成对续接标记（同 token 小圆圈）。
 */
export function paginateTiles(input: PaginateInput): PaginateResult {
  const notes: string[] = [];
  const { active, notes: aNotes } = activeNodeSet(input);
  notes.push(...aNotes);
  const cr = contentRect({
    orientation: input.settings.orientation,
    marginMm: input.settings.marginMm,
    header: input.settings.header,
    footer: input.settings.footer,
  });
  const origin = input.settings.pageOrigin ?? { x: 0, y: 0 };
  const { pages, orphans } = runTilesGrid(input, active, cr, 1, origin, notes);
  return { pages, orphans, totalPages: pages.length, notes };
}

// ---------- flow ----------

/**
 * Flow：文档重排。
 * DFS 主树转打印流（根=大标题，逐级缩进），块绝不跨页截断；
 * 标题/父块与首个子块随行（页底至少带 1 个子块，否则整体翻页）。
 */
export function paginateFlow(input: PaginateInput): PaginateResult {
  const notes: string[] = [];
  const orphans: OrphanWarning[] = [];
  const { active, notes: aNotes } = activeNodeSet(input);
  notes.push(...aNotes);
  const cr = contentRect({
    orientation: input.settings.orientation,
    marginMm: input.settings.marginMm,
    header: input.settings.header,
    footer: input.settings.footer,
  });

  // 建树（首条入边 wins；children 按 id 排序）。
  const parentOf = buildParentOf(input.edges, active);
  const childrenMap = new Map<string, string[]>();
  for (const e of input.edges ?? []) {
    if (!active.has(e.source) || !active.has(e.target)) continue;
    const arr = childrenMap.get(e.source) ?? [];
    arr.push(e.target);
    childrenMap.set(e.source, arr);
  }
  for (const arr of childrenMap.values()) arr.sort();
  let roots = [...active].filter((id) => !parentOf.has(id));
  roots.sort();
  if (roots.length === 0 && active.size > 0) roots = [[...active].sort()[0]!];

  // DFS 预序流（折叠节点后代已在 activeNodeSet 剔除）。
  interface FlowItem {
    id: string;
    depth: number;
    height: number;
  }
  const flow: FlowItem[] = [];
  const stack: Array<{ id: string; depth: number }> = roots.map((r) => ({ id: r, depth: 0 }));
  const seen = new Set<string>();
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (seen.has(top.id)) continue;
    seen.add(top.id);
    const h = input.flowHeights?.[top.id] ?? sizeOf(input, top.id).height;
    flow.push({ id: top.id, depth: top.depth, height: h });
    const kids = (childrenMap.get(top.id) ?? []).filter((c) => active.has(c));
    // 逆序压栈，使按 id 正序展开。
    for (let k = kids.length - 1; k >= 0; k--) {
      stack.push({ id: kids[k]!, depth: top.depth + 1 });
    }
  }

  // 分页：块不截断；父块随行（带首个子块）。
  const pages: PageSheet[] = [];
  let page = makePageSheet(0, { x: 0, y: 0, width: cr.width, height: cr.height }, 1, input.settings);
  let cursorY = 0;
  const kidsOf = (id: string): string[] => childrenMap.get(id) ?? [];

  const startNewPage = (): void => {
    pages.push(page);
    page = makePageSheet(pages.length, { x: 0, y: 0, width: cr.width, height: cr.height }, 1, input.settings);
    cursorY = 0;
  };

  for (let idx = 0; idx < flow.length; idx++) {
    const item = flow[idx]!;
    const x = cr.x + item.depth * FLOW_INDENT_PER_LEVEL;
    const gap = idx === 0 ? 0 : FLOW_BLOCK_GAP_PX;
    const needH = item.height + gap;

    // 单块高于一页内容区 → error 孤块，独占一页。
    if (item.height > cr.height) {
      orphans.push({
        nodeId: item.id,
        severity: 'error',
        message: `块「${item.id}」高于一页内容区（${item.height}px > ${Math.round(cr.height)}px），独占一页。`,
      });
      if (cursorY > 0) startNewPage();
      page.nodeIds.push(item.id);
      page.nodeDrawOffsets![item.id] = { x, y: cr.y + cursorY };
      cursorY += item.height;
      startNewPage();
      continue;
    }

    // widow/orphan：父块若在页底，需至少带一个子块。
    const hasKids = kidsOf(item.id).length > 0;
    let clusterH = needH;
    if (hasKids) {
      const firstKid = kidsOf(item.id)[0]!;
      const kidH = input.flowHeights?.[firstKid] ?? sizeOf(input, firstKid).height;
      clusterH += FLOW_BLOCK_GAP_PX + kidH;
    }

    if (cursorY + clusterH > cr.height) {
      startNewPage();
    }
    const placeH = hasKids ? clusterH : needH;
    page.nodeIds.push(item.id);
    page.nodeDrawOffsets![item.id] = { x, y: cr.y + cursorY };
    cursorY += placeH;
  }
  if (pages.length === 0 || page.nodeIds.length > 0) pages.push(page);

  for (const p of pages) p.nodeIds.sort();
  notes.push(`flow 重排：${flow.length} 个块 → ${pages.length} 页。`);
  return { pages, orphans, totalPages: pages.length, notes };
}
