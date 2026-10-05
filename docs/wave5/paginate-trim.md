# Wave5a-B · 分页空白页裁剪与续接标记标签避让

> 分支：`fix/paginate-blank-trim`（基于 develop `71d2eca`）。
> 范围：`packages/core/src/paginate/`、`packages/web/src/export/`（PrintSheets / svg-export 及对应测试）。
> 两条修复：① tiles 稀疏内容产生的零节点空白页被裁并连续重编号；② 续接标记圆圈与边自由标签文字重叠。

## 1. 根因

### 1.1 零节点空白页
`runTilesGrid` 按内容包围盒（bbox）矩形铺 A4 网格：`cols × rows` 覆盖 bbox 的整体外接矩形。
节点按「中心 / 可完整容纳」规则归页，**一个节点只落在一页**。当内容稀疏时——
主簇与孤块相隔很远、或折叠子树把中间一大块清空——bbox 仍是从最左到最右、最上到最下的矩形，
矩形内部被网格均匀切成很多页，但**这些页上一个节点都没有**。于是导出 / 打印 / PNG / PDF / SVG
以及画布分页叠加层都多出一连串空白 A4 页。

fit 退化路径（`naturalScale<0.25` 复用 `runTilesGrid`）有同样问题。flow 逐块连续排版，页页有节点，
不存在同类空白页（仅防御性跑一遍裁剪，通常空操作）。

### 1.2 续接标记圆圈与标签重叠
两处叠加：

1. **圆圈内塞了整条 edgeId**。`ContinuationMarker.token = cont:<edgeId>`，PrintSheets 直接把
   `{c.token}`（如 `cont:e_n_5_n_12`，十几个字符）画进半径 9px 的小圆圈里，文字溢出圆圈四周，
   压到旁边的边自由标签与节点边框。（svg-export 旧版只 strip 掉 `cont:` 前缀，仍偏长；PrintSheets 完全没 strip。）
2. **边标签固定在贝塞尔中点**，未对附近的续接标记圆圈做避让；浅色 6 色边 / 灰边上文字也缺白色底衬，可读性差。

## 2. 裁剪 / 重编号算法与不变量

新增统一收尾函数 `finalizePages(pages)`（core 零 DOM）：

1. **挑选保留页**：`p.nodeIds.length > 0 || p.preserveBlank`。本次只裁**严格空白页**（零节点）。
   - 保守口径：不实现「近空白（仅边端点 / 标记无节点）」阈值裁剪。按设计要求，拿不准就只裁严格空白页。
   - 不变量：续接标记只挂在「含端点节点」的页上，因此零节点页上不可能有 marker，裁剪不会残留 marker。
2. **旧 index → 新 index 映射**：保留页按原相对顺序连续重编号。
3. **重写页号 + 重映射 marker**：每页 `index = pageNumber = 新序号`；该页每个
   `ContinuationMarker.pageIndex = 本页新序号`，`peerPageIndex = oldToNew.get(旧 peer)`。
   peer 必为含端点节点的保留页（查得到）；查不到则保留原值，避免误指。
4. **坐标不变**：`worldRect`、`nodeDrawOffsets`、节点绘制坐标一律不动——只删页、改序号。
5. **防御**：若保留页为空（不应发生）原样返回，至少留一页。

调用点：
- `paginateTiles`：`runTilesGrid → applyTilesBreaks → finalizePages`。
- `paginateFit` 退化：`runTilesGrid → finalizePages`。
- `paginateFlow`：末尾 `finalizePages`（通常空操作）。

不变量（已被 core 单测 + §9 验收 e2e 断言）：
- 每个节点仍完整且仅出现在一页（零切割不破）。
- 每页 index/pageNumber 连续 0..n-1；`totalPages = pages.length`。
- 共享 cont token 的 marker 成对、互指 peerPageIndex 正确。
- 页眉/页脚页码 `第 i / N 页` 与总页数一致；分页叠加层 `PageBreakOverlay` 与实际导出共用同一个
  `PaginateResult`，预览页数 = 打印/PDF/PNG/SVG 页数。

## 3. 手动分页符例外

`applyTilesBreaks` 把「内部含用户分页线」的页沿轴切成多个带。切出的每个子页打 `preserveBlank = true`。
`finalizePages` 对这类页**即便零节点也保留**——这是用户显式要的页边界，不得裁剪。
未被分页符切到、只是网格自动铺出的零节点页（无 `preserveBlank`）照常裁掉。

同时修正了 `applyTilesBreaks` 重编页号时**未重映射 marker peerPageIndex** 的既有隐患：
现在切页后先建 oldToNew，再统一改写 `pageIndex/peerPageIndex`。

## 4. 标签避让方案（PrintSheets / svg-export）

- **圆圈显示成对短编号**：跨全部页按 token 首次出现顺序分配 `1..N`，两页共享同一编号。
  圆圈内只画短数字（半径 9 容得下 1~2 位），不再塞 edgeId。svg-export 同步生成同一份 token→编号表。
- **边标签推离圆圈**：新 `placeEdgeLabel(mx, my, markers)`，以贝塞尔中点为基准，对该页每个续接标记圆圈做
  迭代斥力（安全半径 20px = 圆半径 9 + 标签半高 + 间隙），把标签平移到不压圆圈处；最多 3 轮稳定。
- **文字可读性**：边标签加白色描边底衬（`stroke:#fff; stroke-width:3; paint-order:stroke`），
  浅色 6 色边与灰边上都清晰；灰模式文字改 `#111827`。

## 5. 测试清单

core `paginate.test.ts` 增补（+4）：
- 稀疏夹具：网格空白页被裁、剩余页连续重编号（12 页 → 3 页）。
- 裁剪后 marker 仍成对、token 相同、互指 peer、索引合法。
- 含节点页不被误裁；孤块页保留并 `warn` 标黄。
- 手动分页符切出的空白页保留（`preserveBlank`）、页码仍连续。
- 调整 fit 退化夹具：原「单个 10000×10000 节点」会被裁成 1 页（那正是本次要修的空白页），
  改为四角铺点，使退化多页且无空白可裁。

回归：core 122→126、web 173 全绿；`pnpm -r build/typecheck/lint` 0 error。

e2e `acceptance-export.spec.ts` 2 项全过：TILES_PAGE_COUNT 12→8（裁掉 4 张空白页），
孤块黄标仍 ≥1、折叠后代仍缺席、矢量 PDF/PNG 多页、文件名含「横向」。

## 6. 前后对比与产物

`/tmp/fix-paginate/`：
- `before-page-1.png` / `after-page-1.png`：同一含跨页边 + 长标签夹具。
  before 圆圈溢出 `cont:e_cross` 长串文字；after 圆圈内为短编号、标签带白底不压圈。
- `tiles-landscape.pdf`（矢量）、`验收样例_..._横向.pdf`（位图 pdf-lib）、逐页 PNG 为真实导出留档。
