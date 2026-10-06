# Wave8：大规模文档渐进水化（10k 块 TTI 收尾）

## 1. 根因

Wave7 把 10k 块 TTI 从 ~105.8s 压到 ~17.8s（修掉 ResizeObserver `report()` 的 O(N²)
反馈环 + rAF 批量 flush），但仍超 15s 目标。本波次定位并消除剩余瓶颈。

**实测探针（本 worktree，headless Chromium，E2E_PORT=4186）**：在 `StaticHtml`/
`BlockShell` 挂计数器后跑 `perf-10k.bench`，发现：

- `renderedDomNodes = 8/10000`（onlyRenderVisibleElements 最终只挂 ~8 个节点），
  但首 commit 期间 `BlockShell` effect 挂载计数 ≈ **20000（StrictMode 双调 = 10000 真实实例）**。
- 即：ReactFlow 首 commit 时视口尺寸尚未测得，`onlyRenderVisibleElements` **不裁剪**，
  把全部 10000 个节点一次性挂载；等尺寸测得后第二帧才卸载离屏的 9992 个。
- 每个被挂载的 `BlockShell` 都跑完整 chrome：4 个 `<Handle>`、`NodeResizer`、
  `ResizeObserver`、hover 工具条、以及 `renderStatic()` → `StaticHtml` →
  `generateHTML(json, getStaticExtensions())`。夹具 10000 块内容互不相同，几乎全是
  generateHTML cache miss。

这与 Wave7 二分一致（`nodeTypes` 换 trivial div → 5.2s；短路 `renderStatic` → 80s）：
剩余 ~12s 长任务就是「首 commit 同步挂载 10000 个重型 BlockShell」，其中
**离屏 `generateHTML`（静态 HTML 序列化）是大头**。注意：离屏并不实例化 Tiptap
Editor（Tiptap 只在双击 `isEditing` 时才 `createBlockEditor`），本波次消除的是
**离屏静态渲染**成本，不是离屏 Tiptap 实例。

## 2. 解法：离屏轻量壳 + 视口邻近升级 + 首屏分片调度

### 2.1 纯逻辑下沉 `packages/core/src/hydration/`（零 DOM/React）

- `visibleWorldRect(vp, pane, bufferScreen)`：屏幕可视区 → 世界矩形（buffer 按 zoom 折算）。
- `boxIntersectsRect` / `selectBoxesInRect`：包围盒相交判定与过滤。
- `planHydration({boxes, viewport, pane, hydrateBufferScreen, deactivateBufferScreen, hydrated, protectedIds})`：
  一次调度计划——`toHydrate`（与可见+缓冲相交、未水合，按离视口中心距离升序）、
  `toDeactivate`（已水合、在更大缓冲之外、未保护，或已不存在于文档）。
  受保护 id（编辑中/选中）强制升级且永不降级。
- `chunkIds(ids, perChunk)`：把待升级列表切片，跨帧分批。
- `extractPlainText(json, maxLen)`：从 Tiptap JSON 递归抽纯文本（占位壳摘要用）。

### 2.2 web 侧

- `editor/canvas/hydration-store.ts`：模块级 `hydrated: Set<id>` + 细粒度
  `useIsHydrated(id)`（useSyncExternalStore，仅自身翻转才重渲染）。
- `editor/canvas/use-hydration-scheduler.ts`：视口/doc 变化时 **rAF 合并**（一帧一次
  plan），调 `planHydration`：降级立即应用；升级按 `chunkIds` 切片，跨
  `requestIdleCallback`（无则 rAF 兜底）分批。仅当 **doc.id 变化**才 `resetHydrated()`
  （同一文档内增删块/打字/移动不重置——否则每键清空水合集导致闪烁/重挂）。
- `nodes/BlockShell.tsx` 拆两层：
  - 外层只订阅「水合态 + 编辑态」；未水合且未编辑 → `BlockShellSkeleton`
    （纯文本摘要 + 同色外壳，**无 Handles / 无 NodeResizer / 无 ResizeObserver /
    无 generateHTML**）。
  - 视口邻近（调度器加入水合集）或编辑中 → `BlockShellFull`（原有全部 chrome +
    `renderStatic()` 完整静态 HTML + Tiptap 编辑）。

### 2.3 不跳动 / 不丢内容 / 不回收交互块

- 占位壳与完整壳共用同一外层定位：节点盒尺寸由 ReactFlow 按 `block.height`/
  `measuredSizes` 保持，升级/降级只换内容子树，不改变节点盒 → 不滚动跳动。
- 内容真相在 store（`block.content.data` / `updateContent`），DOM 只是投影；
  降级回占位壳不影响未保存内容。
- 受保护集（`editingNodeId` ∪ `selection`）永不降级；拖拽块必在视口附近，
  降级缓冲（2000 屏 px）保证「正在交互的块不可能远在屏外」。

### 2.4 与既有优化协同（不回退）

- `setMeasuredSizes` rAF 批量 flush（Wave7）：ResizeObserver 仅在 `BlockShellFull`
  建立，离屏骨架不建 RO，进一步减少首帧 RO 数量。
- `buildChildCountMap`/`useChildCount` O(1)、MiniMap >300 关闭、
  `onlyRenderVisibleElements`、空 lowlight 懒加载：均未改动。
- 打印分页/矢量 PDF/PNG/SVG 走独立 `TiptapStatic`（`export/render/tiptap-static.tsx`），
  不依赖挂载的 BlockShell；搜索 MiniSearch 由 doc 数据构建。本波次只改交互画布渲染，
  这两条路径零改动。

## 3. 三档性能前后对比（本机，headless Chromium）

采样口径：`E2E_PORT=4186 npx playwright test`；TTI = `loadFixture` →
视口节点渲染 + Ctrl+F 开搜索响应；最长 long task 取 `__perfStages.longTasks` 最大值。

| 指标 | Wave7 后（本 worktree 基线） | Wave8 后 | 次数 |
|---|---|---|---|
| **10k TTI** | ~21.6s（单次 21641） | **中位 8.4s**（8427 / 8707 / 8408） | 3 |
| 10k 最长 long task | ~14.7s（14712） | **中位 ~3.9s**（3892 / 3908 / 3814） | 3 |
| 10k afterRaf2 | ~16.2s | ~3.5s | 3 |
| **2000 TTI** | ~2.4–2.7s | **中位 ~2.4s**（2651 / 2427 / 2212） | 3 |
| 2000 最长 long task | ~1.0s | ~0.8s（757/778/824） | 3 |
| **500 拖拽 fps** | 60.0 | 60.0（60.02） | 多 |
| 500 滚轮 fps | 60.0 | 60.0（60.00） | 多 |
| DOM 挂载节点 | 8/10000 | 8/10000（不变） | - |
| 搜索命中「block」 | 1999 | 1999（不变） | - |

10k TTI **21.6s → 8.4s（~2.6×）**，最长 long task **14.7s → 3.9s（~3.8×）**，
达 ≤10s 目标。2000 TTI 不劣化（略快），500 块 60fps 不回退。

## 4. e2e 硬阈值固化（perf-10k.bench.spec.ts）

两级用例：

1. **完整 10k benchmark**：默认 skip，`RUN_BENCH=1` 才跑（手动采样/本机验收），
   现在带**硬阈值**：TTI < 12s、最长 long task < 6s（本机中位 8.4s/3.9s 留 ~40% 余量）。
2. **CI 默认跑的降级规模用例（2000 块）**：门禁全量 e2e 必跑，硬阈值
   TTI < 8s、最长 long task < 3s。

为何降级规模而非直接 10k 卡 CI：GitHub runner 通常比本机慢 2–3× 且方差大，
10k 硬阈值（本机 8.4s）在 CI 可能跑到 20s+ 而 flaky。2000 块量级已能触发
「首 commit 挂载全部节点」路径（onlyRenderVisibleElements 首帧前不裁剪），
本机 TTI 中位 ~2.4s、最长 long task ~0.8s，留 ~3× 余量到 8s/3s，既卡得住
渐进水化逻辑回归，又不被 runner 方差 flaky。完整 10k 仍由 `RUN_BENCH=1`
保留完整采样输出。

## 5. 不回退验证（门禁）

- `pnpm -r build`、`pnpm typecheck`、`pnpm lint`（0 error）：通过。
- 单测：core **194**（基线 176，+18 hydration 纯函数）；web **243**（基线 236，+7
  hydration-store 增量逻辑）。
- e2e：`E2E_PORT=4186 npx playwright test` → **54 passed +1 skipped**（与基线一致）；
  其中 `acceptance-export.spec` 矢量 PDF/PNG/分页/续接标记原样通过，搜索/Ctrl+F 命中数、
  双击建块输入、父子连线均不变。
- `node scripts/verify-precache.mjs`（packages/web）：通过。

## 6. 遗留与取舍

- 首帧仍会挂载全部节点为**骨架壳**（~3.5s afterRaf2）——这是 ReactFlow 首帧
  视口尺寸未测得的固有成本（trivial div 实验地板 ~5s 量级，本波次已压到 ~3.9s）。
  进一步需改 ReactFlow 挂载时机（视口测得前不渲染节点），属更大改动，本波次不做。
- 离屏块的 `<Handle>` 在降级时不挂载；连线只能连视口邻近块（与只能操作可见块一致），
  边 SVG 路径独立渲染不受影响。
- `hydrateBufferScreen=400` / `deactivateBufferScreen=2000` / 每帧升级 12 块为
  经验值；如需更激进的预渲染可加大 buffer。
- 未新增运行时依赖；未触碰 packages/core 零 DOM 边界（hydration 纯函数零 React/DOM）；
  未动 apps/、打印/导出静态路径、边色常量。
