# Wave1-B · layout / paginate 交付说明

> 所有者：Wave1-B（core 纯逻辑：树布局引擎 + A4 分页视图模型）。
> 两者均为零 DOM 纯函数、确定性输出、Vitest 覆盖。
> 未引入 dagre / d3-force / elkjs；未新增依赖（d3-hierarchy 为 core 既有依赖）。

## 1. 最终 API 签名

### 1.1 `packages/core/src/layout/layout.ts`

```ts
export interface MeasuredSize { width: number; height: number }
export interface CollisionReport {
  overlappingPairs: Array<[string, string]>; // 残留重叠对（字典序）
  detouredNodes: string[];                    // 被 pinned 绕行挪动的节点
}
export interface LayoutPosition { x: number; y: number } // 块左上角世界坐标
export interface LayoutResult {
  positions: Record<string, LayoutPosition>;
  collisions: CollisionReport;
  notes: string[];                            // 折叠/绕行/碰撞的人类可读说明
}
export interface LayoutInput {
  nodes: BlockNode[];        // 子集布局时只传该子树；BlockNode.x/.y 作为 pinned 锚点
  edges: Edge[];
  rootId?: string;
  rankSpacing: number;
  nodeSpacing: number;
  measured: Record<string, MeasuredSize>; // 缺失走 DEFAULT_NODE_SIZE
  pinned?: ReadonlySet<string>;
  collapsed?: Readonly<Record<string, boolean>>;
}

export const DEFAULT_NODE_SIZE: MeasuredSize = { width: 260, height: 80 };
export function layoutTree(input: LayoutInput, mode: LayoutMode): LayoutResult;
// mode ∈ 'mindmap-right' | 'mindmap-down' | 'org-tree'；'radial' 抛错（P1 预留）
export type { LayoutMode };
```

### 1.2 `packages/core/src/paginate/constants.ts`

```ts
export const A4_WIDTH_MM = 210, A4_HEIGHT_MM = 297, CSS_DPI = 96;
export const A4_PORTRAIT_PX = { width: 793.7, height: 1122.5 }; // mmToPx(210/297)
export const A4_LANDSCAPE_PX = { width: 1122.5, height: 793.7 };
export const TILES_OVERLAP_MM = 10;
export const HEADER_BAND_PX = 24, FOOTER_BAND_PX = 24;
export const FLOW_INDENT_PER_LEVEL = 28, FLOW_BLOCK_GAP_PX = 8;
export function mmToPx(mm: number): number;
export function pxToMm(px: number): number;
export function pagePixelSize(orientation): { width; height };
export function contentRect(settings: ContentRectSettings): { x; y; width; height };
// ContentRectSettings = { orientation; marginMm; header?; footer? }
```

### 1.3 `packages/core/src/paginate/paginate.ts`

```ts
export interface ContinuationMarker {
  token: string; edgeId: string; pageIndex: number;
  x: number; y: number; peerPageIndex: number;
}
export interface OrphanWarning { nodeId: string; severity: 'warn'|'error'; message: string }
export interface PageSheet {
  index: number; pageNumber: number;
  worldRect: { x; y; width; height };
  nodeIds: string[]; edgeIds: string[];
  continuations: ContinuationMarker[];
  scale: number;
  nodeDrawOffsets?: Record<string, { x: number; y: number }>; // 页本地 px
  headerText?: string; footerText?: string;
}
export interface PaginateSettings extends PageSettings {
  headerText?: string; footerText?: string;
  showEdgeLabels?: boolean; grayScale?: boolean;
  // showPageNumbers / pageOrigin 来自 PageSettings
}
export interface PaginateInput {
  layout: LayoutResult;
  measured: Record<string, MeasuredSize>;
  settings: PaginateSettings;
  scopeNodeIds?: string[];
  nodes?: BlockNode[];       // flow 建树/兜底用
  edges?: Edge[];            // tiles 跨页续接 / flow 建树
  collapsed?: Readonly<Record<string, boolean>>;
  flowHeights?: Record<string, number>; // flow 实测高覆盖
}
export interface PaginateResult {
  pages: PageSheet[]; orphans: OrphanWarning[];
  totalPages: number; notes: string[];
}
export function paginateFit(input): PaginateResult;
export function paginateTiles(input): PaginateResult;
export function paginateFlow(input): PaginateResult;
```

## 2. 算法说明

### 2.1 layoutTree

1. **自包含建树**：由 `edges` 建 parent→children；同一 target 的**首条入边 wins**，余边忽略；访问过的节点不再展开（成环不致死循环，环边被截）。多根（森林/子集）时挂一个不可见超根供 d3 排布，输出前丢弃。子节点按 id 字典序排序，保证确定。
2. **实测尺寸**：`measured[id]` 缺失时用 `DEFAULT_NODE_SIZE`（260×80）。
3. **d3.tree() 三模式**：
   - `mindmap-right`：深度轴向右。输出 `x = d3.y`、`y = d3.x`；`nodeSize = [maxH+nodeSpacing, maxW+rankSpacing]`（d3 常量 nodeSize 取全局极值占位以保证不重叠）。
   - `mindmap-down`：不交换，根在上；`nodeSize = [maxW+nodeSpacing, maxH+rankSpacing]`，纵向 pitch 随 d3 槽位（逐节点尺寸驱动）。
   - `org-tree`：同向下，但**固定行高对齐**——每一行高度 = 该行内最大实测高 + nodeSpacing，同层节点顶对齐（y = 行顶），父节点由 d3 tidy 排布水平居中于子树。与 mindmap-down 的差异在 JSDoc 写明。
4. **坐标归一化**：被布局簇整体平移，使最小左上 = (0,0)；pinned 节点不参与归一。
5. **collapsed**：`collapsed[id]=true` 时 id 成为叶子，全部后代从布局剔除。
6. **pinned 绕行**：pinned 节点以其 `BlockNode.x/.y` 为锚点不动；被布局节点与 pinned 矩形重叠时沿布局轴最小平移避让（right 推 y、down/org 推 x），最多 3 轮，被避让节点记入 `collisions.detouredNodes`。
7. **仅选中分支**：`input.nodes` 为子集时只返回该子集位置；子集根的父不在集合内时，该根即作为 d3 根从 (0,0) 起排。
8. **碰撞复检**：输出前对所有节点对做 AABB 重叠检测，残留重叠进 `collisions.overlappingPairs`；notes 记录折叠/绕行/碰撞说明。

### 2.2 paginateFit

1. 过滤 active 节点（scope + 折叠后代剔除），算世界包围盒。
2. `scale = min(cw/bw, ch/bh)`，夹到 ≤2。
3. 单页：内容在内容区居中，`nodeDrawOffsets` 为页本地 px；active 边整段绘制。
4. 若 `scale < 0.25`（内容远超单页）→ 退化为固定 `scale=0.25` 的 tiles 网格（复用 `runTilesGrid`），notes 说明。

### 2.3 paginateTiles

1. 以 `settings.pageOrigin`（默认 (0,0)）为世界起点，按内容区尺寸铺 A4 网格，相邻页步长 = 内容区尺寸 − 10mm 重叠带。
2. 节点按包围盒**中心**归属页；盒越出该页右/下边界时整体挪到下一相邻页（`nodeDrawOffsets` 表达页本地绘制坐标，世界坐标不变）。
3. 边两端同页 → 进 `edgeIds`；跨页 → 两端各生成一个 `ContinuationMarker`，token = `cont:<edgeId>`，互为 `peerPageIndex`，落点夹到该页内容区边界附近。
4. 节点大于单页内容区 → `OrphanWarning(severity='warn')`。
5. 网格自动扩展至覆盖全部内容；pages 按行序（j*cols+i）编号。

### 2.4 paginateFlow

1. DFS 主树预序（根=大标题，深度 → 缩进 `28px/级`）。
2. 块纵向依次排列，高取 `flowHeights[id] ?? measured[id].height`，块间隙 8px。
3. 按内容区高度分页；**块绝不跨页截断**（放不下整块即翻页）；单块高于一页内容区 → `OrphanWarning(severity='error')` 且独占一页。
4. **widow/orphan**：父块（有子块）在页底时需至少带首个子块，否则整体翻页。
5. 折叠子树后代剔除；`scopeNodeIds` 支持。

## 3. 已知限制

- **d3 nodeSize 为常量**：因 d3-hierarchy 的 `tree().nodeSize([w,h])` 只接受常量，本实现以全局实测宽/高极值作为槽位占位（保证同层不重叠）；不等尺寸树的「紧凑」非最小包围，预留 P1 改进（按子树实际宽度分配槽位）。
- **pinned 锚点**：pinned 节点的世界坐标取自 `BlockNode.x/.y`；若 pinned 与被布局簇归一化后的原点相距较远，整体画布可能出现负坐标（仅来自 pinned 锚点）。
- **tiles 续接标记位置**：当前为端点在内容区内的夹取点，未做精确的边切线方向/箭头方向渲染（渲染层负责）。
- **flow 多根**：多根时按字典序依次铺排，未做多栏平衡。
- **手动分页符（pageBreaks）**：PageSettings 已保留字段，本期未在三模式中消费（P1）。
- **radial / dag / force**：按 P0 override 不实现；调用 `layoutTree(..., 'radial')` 抛错。

## 4. 测试清单（Vitest，确定性夹具）

layout（`layout/layout.test.ts`，9 例）：
1. mindmap-right 深度 x 递增、同层 y 不重叠
2. mindmap-down y 随深度递增
3. org-tree 固定行高 + 同层顶对齐（d/e 顶边相等）
4. 实测缺失走 DEFAULT_NODE_SIZE
5. collapsed 后代无位置、折叠节点自身保留
6. pinned 坐标不变 + detouredNodes 含 a + 无残留重叠
7. 仅选中分支只返回子集位置
8. radial 抛错
9. 归一化后整体无负坐标

paginate（`paginate/paginate.test.ts`，12 例）：
- constants：A4 像素、mmToPx、10/15/20mm contentRect、页眉页脚 24px（4 例）
- fit：单页 scale、超小内容 ≤2×、超大内容退化多页且 scale=0.25（3 例）
- tiles：跨页边成对 marker + token 相同、跨边界节点只在一页（2 例）
- flow：多页每节点完整一页、折叠后代不出现、超高块 error 警告（3 例）

合计 25 例（含既有 smoke 4 例），全部通过。
