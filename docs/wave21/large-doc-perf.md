# Wave21：超大画布性能收尾与阈值固化

## 背景

Wave8 已建好渐进水化调度器、布局 Web Worker、视口虚拟化（`onlyRenderVisibleElements`）。
本波（Wave21）是「预算调优 + 指标固化」，不重写架构：

1. 把调度器里硬编码的分片片长/间隙改为 deadline 驱动；
2. 把边/小地图渲染的魔法数提取为命名常量并标定；
3. 把性能指标从「仅 console.log 报告」升级为 CI 必跑的阈值断言。

## 调了哪些预算

### use-hydration-scheduler.ts

**改前**：固定 `CHUNK_PER_TICK = 12`，每 idle 回调硬处理 12 个节点，不管 deadline 剩多少；
rIC timeout 固定 200ms；首开时第一批也要等 rIC。

**改后**：

| 常量 | 值 | 标定依据 |
|---|---|---|
| `HYDRATE_BUFFER_SCREEN` | 400 px | 视口外扩 400px 内的块升级；保留不变（实测足够预判滚动） |
| `DEACTIVATE_BUFFER_SCREEN` | 2000 px | 视口外扩 2000px 外降级；保留不变（平衡内存与稳定性） |
| `MAX_IDLE_TICK_MS` | 25 ms | 每 tick 目标占用主线程上限，远低于 50ms Long Task 阈值 |
| `MIN_CHUNK` | 4 | 即使 deadline 很紧也至少推进 4 个，保证收敛 |
| `MAX_CHUNK` | 24 | 极空闲帧最多处理 24 个，防止一口气批量渲染造成 DOM 抖动 |
| `FIRST_TICK_IMMEDIATE` | 8 | 首开第一批同步升级 8 个可见节点（不等 rIC），抢首屏可见时间 |
| `RIC_TIMEOUT_FIRST` | 100 ms | 首开时短超时，浏览器一有空就升级，不等到 200ms |
| `RIC_TIMEOUT_STEADY` | 300 ms | 稳态滚动时长超时，让浏览器挑空闲时机，不抢交互帧 |

**核心改动**：`scheduleIdleTick` 现在把 `IdleDeadline` 透传给回调；
`step()` 里用 `deadline.timeRemaining()` 动态算片长（每节点 ≈2ms 渲染成本），
而不是固定切 12 个。首开时第一批 8 个节点在 effect 里同步跑（不等 rIC），
让视口内最关键的节点尽快升级为完整渲染。

### CanvasEditor.tsx — 小地图/边渲染阈值

| 常量 | 值 | 标定依据 |
|---|---|---|
| `MINIMAP_NODE_LIMIT` | 300 | ≤300 节点时 MiniMap 全开（~300 SVG DOM <10ms）；>300 关闭，用右下角缩放控件导航 |
| 边渲染 | 无额外抽样 | ReactFlow `onlyRenderVisibleElements` 已按视口裁剪屏幕外边；视口内可见边通常 <50 条 |

**为什么不做 MiniMap 节点抽样**：MiniMap 的价值是全局位置感知，抽样后密度失真反而误导。
直接关闭 + 提供缩放控件更诚实。未来若开 MiniMap `edgeColor`，需加 `MINIMAP_EDGE_LIMIT`。

## 采样方法

### 环境

- 机器：4 核本机，无头 Chromium
- CI 模拟：`taskset -c 0` 绑定单核（比 GitHub ubuntu-latest 2 核共享更严格）
- 运行方式：`E2E_PORT=4421 taskset -c 0 npx playwright test performance.spec.ts`

### 500 块交互采样

在页面内启动 rAF 帧采样（200ms 预热 + 400ms 采样窗口），同时在 Node 侧触发鼠标交互
（拖拽节点 / 滚轮缩放 / 画布平移）。采样窗口内同时挂载 `PerformanceObserver` 记录 Long Task。

统计指标：
- `fpsMedian`：帧间隔中位数 → 1000/medianInterval
- `fpsWorst`：最长帧间隔 → 最差瞬时 fps
- `longTaskCount` / `longestLongTask`：采样窗口内的长任务数与最长长任务

### 2000 块加载采样

从 `loadFixture` 触发开始计时，到视口节点渲染 + Ctrl+F 搜索面板出现为止 = TTI。
Long Task 由 dev-hooks 的 `PerformanceObserver` 在 `__perfStages.longTasks` 记录。

## 实测分布表

### 500 块交互（taskset -c 0，5 次连跑）

| Run | Drag fpsMedian | Wheel fpsMedian | Pan fpsMedian | Min Median FPS | Long Tasks | Worst Long Task |
|-----|---------------|-----------------|---------------|----------------|------------|-----------------|
| 1   | 59.9          | 59.9            | 59.9          | 59.9           | 0          | 0               |
| 2   | 59.9          | 59.9            | 59.9          | 59.9           | 0          | 0               |
| 3   | 59.9          | 59.9            | 59.5          | 59.5           | 0          | 0               |
| 4   | 59.9          | 59.9            | 59.9          | 59.9           | 0          | 0               |
| 5   | 59.9          | 59.9            | 59.5          | 59.5           | 0          | 0               |

**结论**：500 块交互在单核限频下满帧 60fps，零长任务。视口内只渲染 ~8 个节点。

### 2000 块加载（taskset -c 0，5 次连跑）

| Run | TTI (ms) | nodesRendered (ms) | interaction (ms) | Longest Long Task (ms) |
|-----|----------|--------------------|------------------|------------------------|
| 1   | 3194     | 2611               | 583              | 1052                   |
| 2   | 3005     | 2526               | 479              | 1081                   |
| 3   | 2687     | 2483               | 204              | 1054                   |
| 4   | 2971     | 2411               | 560              | 1035                   |
| 5   | 3044     | 2499               | 545              | 1051                   |
| **中位** | **3005** | **2499** | **545** | **1054** |
| **范围** | 2687–3194 | 2411–2611 | 204–583 | 1035–1081 |

**结论**：2000 块 TTI 中位 ~3s，最长长任务 ~1.05s（ReactFlow 首 commit 挂载全部占位壳）。
调度器后续分批升级在 idle 帧完成，不追加显著长任务。

## 阈值取值依据

| 断言 | 阈值 | 实测分布 | 余量 | 依据 |
|------|------|----------|------|------|
| 500 块 min median FPS | ≥ 24 | 59.5–59.9 | ~2.5x | 规划值 ≥30fps 为目标线；CI runner 共享 CPU 可能掉帧，取 24 作为防回归红线。跌到 24 以下说明有明显长任务回归。 |
| 500 块交互长任务数 | ≤ 2 | 0 | — | 拖拽/缩放/平移过程中不应出现长任务；0 是理想值，2 留 CI 调度抖动余量。 |
| 500 块最长长任务 | < 200ms | 0 | — | 交互中偶发的 GC 或布局抖动不应超过 200ms。 |
| 2000 块 TTI | < 8000ms | 2687–3194 (单核) | ~2.5x | 本机单核中位 ~3s；CI runner 按 2x 慢机估算 ~6s；8s 留 ~33% 余量。与 perf-10k.bench §9c 对齐。 |
| 2000 块最长长任务 | < 3000ms | 1035–1081 (单核) | ~2.8x | 本机 ~1.05s；CI 2x 慢机 ~2.1s；3s 留 ~30% 余量。 |
| 2000 块交互响应 | < 1500ms | 204–583 | — | TTI 前最后一次交互（Ctrl+F）响应预算。 |

### 为什么用 fps 中位数 + 长任务双指标

fps 中位数反映「典型交互流畅度」，但在 headless/CI 容器里可能因 GPU 合成器不可用
而天然偏低（rAF 可能被节流到 30fps）。因此叠加长任务数量/时长作为更鲁棒的
负载指标：即使 fps 因合成器节流降到 30，只要主线程没有 >50ms 的长任务，
交互本身就是流畅的。双指标任一突破都说明有真实回归。

## CI 鲁棒性说明

- `workers: 1` 串行跑（playwright.config.ts 已配），避免多 worker 抢 CPU 干扰测量。
- 阈值取本机单核实测的 P99 上界 × ~2.5 余量，覆盖 GitHub runner 的性能波动。
- 500 块 fps 阈值 24fps 远低于实测 60fps，即使 CI runner 慢 2x 也不会误红。
- 2000 块 TTI 8s 对应 CI runner 上 ~6s 的预期值，留 2s 抖动空间。
- 若未来 CI runner 性能变化导致阈值偏紧/偏松，调整时必须在本文件记录新的实测分布。

## perf-10k.bench.spec.ts 定位

- §9b（10000 块）：`RUN_BENCH=1` 才跑，手动验收用，不随 CI 运行。
- §9c（2000 块）：CI 默认跑，纯加载 TTI + 长任务阈值，与 performance.spec.ts 互补。
  performance.spec.ts 的 2000 块用例额外验证搜索命中和平移可交互性。
