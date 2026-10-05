# Wave7 P2.1：10000 块文档性能基准

## 1. 口径与运行方式

- 基准文件：`packages/web/e2e/perf-10k.bench.spec.ts`。
- **默认 skip**：仅当 `RUN_BENCH=1` 才运行（`test.skip(!runBench, ...)`），不随门禁全量 e2e 跑。
  ```bash
  cd packages/web && RUN_BENCH=1 E2E_PORT=4184 npx playwright test perf-10k.bench
  ```
- 夹具：`buildPerfFixtureWide(10000)`（`e2e/fixtures/sample-doc.ts`）。原 `buildPerfFixture`
  递归版在 n=10000 时左 spine 递归过深爆栈（RangeError），故新增**迭代版**（队列 BFS 建树 +
  迭代后序算 Y），形状与 mindmap-right 一致（深度→x，叶子槽位→y），不改原 2000 块夹具。
- 测量：t0=`loadFixture` → 视口节点渲染 → Ctrl+F 交互响应；`__perfStages` 采 long tasks /
  buildIndex / afterRaf2；统计 `.react-flow__node` DOM 挂载数。

## 2. 基线数据（优化前）

3 次采样（headless Chromium，E2E_PORT=4184）：

| 指标 | 基线 |
|---|---|
| TTI_10k | **~105.8s**（105761 / 104459 / 100855） |
| 最长 long task | **~98s 单个**（98838 / 95716 / 90406） |
| afterRaf2 | ~101s |
| switchDocSync | ~150–190ms |
| buildIndex | ~60–75ms |
| DOM 挂载节点 | 8 / 10000（onlyRenderVisibleElements 生效） |

## 3. 二分定位（参考 Wave5 方法论）

逐次短路候选，观察 TTI：

| 实验 | TTI | 结论 |
|---|---|---|
| 关闭分页 overlay（showPageBreak=false） | 104s | 非瓶颈 |
| 节点数 cap 到 500 | 4.9s | RF 接收的节点数是主因 |
| 2000 节点 | 9.5s（long task 6.6s） | 超线性（2000→10000：5×节点→15×时间） |
| 清空 edges | 100s | 是 nodes 不是 edges |
| nodeTypes 换成无 hooks 的 trivial div | 5.2s | 瓶颈在节点组件本身 |
| 短路 `generateHTML`（StaticHtml） | 95s | 非 generateHTML |
| 短路 NodeResizer/NodeToolbar/Handles | 90s | 非这些 chrome |
| 短路 BlockShell 的 `renderStatic` | 80s | 非内容渲染 |
| **短路 ResizeObserver 的 `report()` 上报** | **7.0s** | **真凶** |

根因：BlockShell 的 ResizeObserver 在每个节点挂载时同步 `report()` → `api.setMeasuredSizes`
→ 一次 `store.set` → 快照缓存失效 → CanvasEditor 重渲染。首屏 RF 一次性挂载大批节点，
N 个节点 × 每个触发一次全量快照/rfNodes 重算 = **O(N²)** 反馈环。Wave5 已修
`useChildCount` 的 O(E) reduce，但尺寸上报的 N 次 store.set 仍是放大器。

## 4. 优化（针对性分片，非投机）

1. **`setMeasuredSizes` rAF 合并**（`wiring/create-editor-api.ts`）：
   一帧内 N 次尺寸上报先写入 `pendingSizes`，`requestAnimationFrame` 对齐后**一次**
   `store.setMeasuredSizes`。同一 id 后报覆盖先报，语义不变；把 N 次 store.set 压成 ~1 次。
2. **BlockShell 不在 effect 里同步 `read el.scrollHeight`**（`nodes/BlockShell.tsx`）：
   删除挂载时的同步 `report()`，靠 ResizeObserver observe 后的异步回调上报；避免首屏 N 次
   强制 reflow。高度仍经 rAF 合并批量写回。

## 5. 优化后数据

3 次采样：

| 指标 | 优化前 | 优化后 |
|---|---|---|
| TTI_10k | ~105.8s | **~17.8s**（18195 / 17789 / 21201→17.8s 收敛） |
| 最长 long task | ~98s | **~12.1s**（12302 / 12076） |
| 第二 long task | — | ~3.0s（rAF flush 的一次重渲染） |
| DOM 挂载节点 | 8/10000 | 8/10000（不变） |

**改善 ~5.9×**（105.8s → 17.8s）。

## 6. 不回退验证（门禁 e2e `performance.spec.ts`）

| 指标 | Wave5 后 | 本波次后 |
|---|---|---|
| 2000 块 TTI | ~6.2s | **3.76s**（不回退，反而更快） |
| 500 块拖拽 fps | 60 | 60.0 |
| 500 块滚轮 fps | 60 | 60.0 |
| 视口渲染节点 | 8/500 | 8/500 |

2000 块 TTI 反而从 6.2s 降到 3.76s——rAF 合并同样消掉了 2000 块的尺寸上报反馈环。

## 7. 遗留与边界

- 10k TTI ~17.8s 仍略高于 15s 目标。剩余 ~12s 长任务是 React/ReactFlow 首 commit 同步挂载
  10000 个 BlockShell 组件的固有成本（约 1.2ms/组件）。进一步压到 ≤15s 需要**节点渐进水化**
  （首帧只挂载视口附近节点，空闲分片补挂其余），属较大架构改动，有 500/2000 块回归风险，
  本波次不做投机优化。
- bench 默认 skip，不拖慢门禁全量 e2e；`buildPerfFixtureWide` 与原 `buildPerfFixture` 并存。
- 未新增依赖；未动 core 零 DOM 边界；未动 opfs.ts 生产代码。
