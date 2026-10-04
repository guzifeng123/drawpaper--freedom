# Wave2b · M1（P0）独立验收与加固报告

验收对象：drawpaper M1（P0 闭环）。本报告对应规划文档 §9 验收口径，逐条给出自动化证据、产物路径、性能数值与修复清单。

分支：`feat/verify-m1-e2e`（基于 develop `3bdbc2b`）。

## 0. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 构建 | `pnpm -r build` | ✅ 通过 |
| 类型 | `pnpm -r typecheck` | ✅ 通过（core + web） |
| 静态检查 | `npx eslint .` | ✅ 0 error / 0 warning |
| 单测 | `pnpm -r test` | ✅ core **81** passed（原 78 + 新增 3 条核心强断言）；web **75** passed（无回归） |
| e2e | `npx playwright test` | ✅ **10 passed** |

零外网核查：`packages/web/dist/assets/*.js` 内 `http(s)://` 出现项均为
库归因/错误码链接（pdf-lib github、reactflow attribution、react error-decoder、prosemirror docs）
与 W3C SVG/XML 命名空间 URI，**无运行时 fetch/XHR/WebSocket/外链 script/字体 CDN**；
`grep -c __drawpaper__ dist` = 0，DEV 测试钩子未进入生产产物。

## 1. §9 导出硬性验收（core 级强断言）

新增 `packages/core/src/paginate/acceptance.test.ts`，对标准 30 块夹具（≥3 块型、≥4 层、横向超页、1 孤块、1 折叠子树）做像素级测量：

| 断言 | 证据 |
|---|---|
| tiles：每节点完整且仅出现在一页（nodeDrawOffsets 后绘制矩形 contained in 内容区，零切割） | ✅ `acceptance.test.ts › tiles › 标准30块样例`，逐节点 clamp 边界 ±1px 断言 |
| 跨页边 ContinuationMarker 成对、token 相同、互指 peerPageIndex | ✅ 同上，按 token 分组断言 length=2 |
| 孤块（无连接分量）存在 OrphanWarning 并渲染 | ✅ `orphanBadges>=1`（e2e）；core `disconnectedOrphans` |
| 折叠子树节点全部缺席、折叠节点自身保留 | ✅ core + e2e `[data-node-id]` 计数为 0 |
| flow：每节点完整落一页、超高块 error | ✅ `flow › 每节点完整落在一页`、`单块高于一页→error` |
| fit：小图单页等比；scale<0.25 退化多页 | ✅ `fit › 小图单页`、`超大图退化多页` |

## 2. §9 真实产物 e2e（无头 chromium）

产物目录：`packages/web/test-results/acceptance/`

| 产物 | 路径 | 说明 |
|---|---|---|
| 矢量 PDF（横向 A4） | `tiles-landscape.pdf`（40 KB） | `page.pdf({format:A4, landscape, printBackground, margin:0})` |
| 逐页截图（12 页） | `tiles-landscape-page-{1..12}.png` | 每页零切割检查、续接标记成对、页眉页脚页码、孤块黄标 |
| 黑白样例 | `tiles-grayscale-page1.png` | 无彩色边 |
| 高清 PNG（像素比 3） | `验收样例_20261005_横向_p{1..10}.png`（每页 ~190–335 KB） | html-to-image 路径 |
| 直接下载 PDF（位图 pdf-lib） | `验收样例_20261005_横向.pdf`（750 KB，多页） | 文件名含日期 + 横向 |

文字可选：系统 `pdftotext` 可用，从矢量 PDF 抽出 `验收样例 / bullet#3 / 孤块-无连接 / 第 1 / 12 页`，证明为真矢量（非位图）。

## 3. 性能（§9）

| 指标 | 数值 |
|---|---|
| 500 块拖拽中位帧率 | **60.0 fps**（rAF 采样 350ms） |
| 500 块滚轮缩放帧率 | **60.0 fps** |
| 视口内渲染节点数 / 总数 | **8 / 500**（onlyRenderVisibleElements 生效，远小于总数） |
| 2000 块打开 | 可加载、无崩溃、可平移；耗时 **~63s**（见「限制」） |

无头环境帧率未被节流（采样到 60fps 上限）。拖拽期间无 Tiptap 实例爆发（仅可见块挂载）。

## 4. Wave2a 四个已知缺口处理结论

| # | 缺口 | 结论 |
|---|---|---|
| ① | 新建文档后侧栏不即时刷新 | **已修**。`store.flushSave` 成功后 `listDocs()` 刷新侧栏；e2e `SIDEBAR_ITEMS` 由 0→16，`text=还没有文档` 消失。 |
| ② | 导出弹窗「边标签」开关未写回 PageSettings | **已修**。`PageSettings.edgeLabels`（zod 默认 true）+ 开关 `onCheckedChange→setPageSettings({edgeLabels})`；e2e 关闭后 `doc.page.edgeLabels===false`。 |
| ③ | undo 后相机回位 | **已修**。CommandStack 暴露 `lastUndoName`，store 记录 `historyEvent{kind,name,nonce}`；CanvasEditor 对宏撤销（confirm-layout 等）在 60ms 后 `fitView`。 |
| ④ | tiles 跨页节点未整体移页（位图 PDF 疑似切割） | **已修**。重写节点归属：选能完整容纳节点的页索引区间，死区则把绘制矩形 clamp 回内容区；PrintSheets 改消费 `nodeDrawOffsets`（唯一真相）。core 强断言 + 逐页截图零切割。 |

## 5. 验收中发现并修复的其他缺陷

- **导出忽略折叠子树**：`useExportModel` 原未传 `collapsed`，折叠后代被导出。现从 `node.collapsed` 推导 map 传入（fit/tiles/flow 三路）。
- **续接标记双倍 margin**：PrintSheets 把 core 已含 `cr.x` 的 marker 坐标又加了一次 margin，修正为直接使用。
- **离群块（断开分量）无警告**：新增 core `disconnectedOrphans` 并在三模式产出 OrphanWarning（孤块黄标）。

## 6. 未决 / 限制

- **2000 块打开 ~63s**：同步 `loadDoc` + 首次渲染 + Dexie 落盘在无头环境偏重；P0 目标「可打开、无崩溃、可平移」达成，但加载耗时未优化（P1 范围内考虑分页/懒加载索引）。
- **续接标记旁的边标签文字**在截图中与圆圈略有重叠（标签定位紧贴边界），不影响零切割与成对语义，列为 P1 视觉微调。
- 本批 e2e 聚焦 §9 硬验收 + 四缺口 + 性能；规划 §二.2 的全量交互矩阵（中文输入法合成态、多父/成环弹窗、右键菜单等）沿用既有单测覆盖，未逐条新增 e2e（P1 增量）。
- P1 功能（大纲/深色/AI/OPFS UI/放射布局）不在本轮，仅记录未修。
