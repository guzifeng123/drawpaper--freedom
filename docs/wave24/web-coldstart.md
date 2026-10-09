# Wave24 路 3：前端冷启动量化与优化

基线 `rc.15 = f991531`。本路只动 web 侧（`packages/web`），零新依赖（`pnpm-lock.yaml` 零 diff）、
零外网、core 零 DOM/React、不碰 Cargo/Tauri。所有结论为 before/after 实测（Playwright × Chromium，
`taskset -c 0,1` 对齐 CPU，每格 7 次取中位数 / P90）。

## 1. 分段埋点字典

时间基统一 `performance.timeOrigin`（= navigation start）。实现：
`packages/web/src/wiring/cold-starts.ts`（零依赖，只读 Performance Timeline）。

| 时间点 | 类型 | 触发点 |
| --- | --- | --- |
| `boot` | mark | `main.tsx` 模块求值起点 |
| `store` | mark | `editor-store` 单例创建完成 |
| `bootstrap` | mark | `bootstrap()` 开始 |
| `idb-open` | measure | 首次 IDB 操作（Dexie 打开 + `listDocs` 全量列表） |
| `doc-open` | mark | 最近文档载入 store（`openDoc`/`newDoc`） |
| `bootstrap-done` | mark | `bootstrap()` 收尾 |
| `search-index` | mark | MiniSearch 索引分片喂完（Wave24 起为分片异步完成点） |
| `collab` | mark | `collabManager.install()` 返回 |
| `sync-restore` | measure | `syncController.restore()` 落定 |
| `asset-reconcile` | measure | `reconcileAssetRefs()` 落定（Wave24 起延迟到首帧后 idle） |
| `render-start` | mark | `ReactDOM.render` 调用 |
| `react-commit` | mark | App 首个 effect（首次 commit 后） |
| `canvas-frame` | mark | 挂载后双 rAF（浏览器已首绘） |
| `tti` | mark | 首帧后连续可交互窗口：无 >50ms Long Task 且 rIC 空闲 |

导航侧另读 `PerformanceNavigationTiming`（domContentLoaded / load / responseEnd /
`transferSize`——0 即首包无网络字节（SW/HTTP 缓存命中））与 `first-contentful-paint`。

全局只读出口：`window.__coldStart.report()` → 上述 marks / measures / navigation / fcp /
longTasks。**dev 与 production preview 都挂**，不依赖 `__drawpaper__` DEV 钩子。

### Tauri 下采集（外推限制）

红线规定本路不动 Cargo/Tauri（路 1/2 领地），故**未**把分段接入 `--diag-export` 的 Rust
诊断包：那需要新增一条 `#[tauri::command]` 桥 + 在 `diagnostics.rs` zip 里加条目，越界。
Tauri WebView2 下的手动采集法：devtools Console 里 `__coldStart.report()` 即得全部分段；
或 `--remote-debugging-port` 起进程后用 CDP 读 performance entries。Chromium 相对 before/after
的**分段差值**在 WebView2 上成立（同一 Chromium 内核），但绝对值需在 Windows 真机复测——
本机无 Windows 真机，本路数字均为 Linux Chromium 无头口径。

## 2. 采集方法

- 脚本：`packages/web/scripts/measure-coldstart.mjs`（非 CI 门禁；门禁见
  `e2e/wave24-coldstart.spec.ts`）。
- 启动：`taskset -c 0,1 node scripts/measure-coldstart.mjs --base <url> --scenario empty|heavy --runs 7`。
- heavy 场景：经裸 `indexedDB.put('drawpaper-db'/'docs')` 写入 2000 块样例（复刻
  `buildPerfFixture` 的 mindmap-right 双叉树），随后每次导航走真实
  `bootstrap → listDocs → openDoc`，即真实重文档冷启动。
- dev 组：vite dev server；preview 组：`pnpm build` 后 `vite preview`（生产产物 + SW）。

## 3. Before / After 分段表（中位数 / P90，ms）

### preview-heavy（生产产物，2000 块——最关键场景）

| 段 | before med/P90 | after med/P90 | 变化 |
| --- | --- | --- | --- |
| FCP | 320/324 | **76/100** | −244（首帧占位 splash） |
| canvas-frame | 286/296 | 287/316 | 持平 |
| doc-open | 777/810 | 782/820 | 持平 |
| idb-open | 201/212 | 198/225 | 持平 |
| asset-reconcile（关键路径） | 1745/1808 | **26/37** | −1719（延迟到首帧后 idle，不再与启动竞争） |
| render→commit | 127/133 | 128/131 | 持平 |
| **TTI** | **2065/2149** | **2048/2080** | **−17（不劣于 before，远低于 8s 红线）** |

### preview-empty（生产产物，空文档）

| 段 | before med/P90 | after med/P90 |
| --- | --- | --- |
| FCP | 348/464 | **88/128** |
| TTI | 363/447 | 366/511（持平） |
| asset-reconcile | 191/293 | **3/32** |

### dev-heavy / dev-empty

dev 为未打包模块图，绝对值偏高且与生产不可比；形状一致：FCP 792→40 / 804→48，
TTI 3779→3688（−91）/ 855→880（持平）。

## 4. 优化项与增益（每项独立可回滚）

1. **首帧占位 splash（`index.html`）**：JS 下载期间先给品牌色画布，React 首 render 即清空。
   FCP −244ms（preview-heavy）。零 JS、零外网。保留。
2. **资产 reconcile 延迟到首帧后 idle（`main.tsx`）**：实测它在 2k 块启动窗口内产生
   多个 300ms+ 后台长任务与主线程竞争。改为首帧后首个 `requestIdleCallback`（超时 3s）再跑。
   幂等迁移、无前置依赖，正确性不受影响。关键路径 −1719ms。保留。
3. **MiniSearch 索引分片喂入（`search-index.ts` + `editor-store.ts`）**：2k 块下同步
   `buildIndex` 是一个 ~865ms 连续长任务。改为空占位 + 60 片/次 rIC 喂入，喂完回放当前
   搜索词。最长 Long Task 由 755ms 降到 435ms；`bootstrap-done` 1642→1575ms。
   TTI 本身基本持平——数据证明该段原本就在与水合渲染并发，分片只消除连续长任务、不移动
   TTI（诚实结论，不夸大）。保留：消除连续长任务对交互响应是纯收益。

### 评估后未采纳（无分段增益，未改动）

- **collabManager.install() 延迟**：实测 `collab` mark 近乎瞬时（3 个 interval 创建），
  无线程程增益，且多标签协作 e2e 依赖其早期就绪——不动。
- **IDB/OPFS 并行化**：`idb-open` 本就与 React render 并发（async），无可压。

## 5. 红线自检

- 2000 块 TTI 硬阈值 8s：after 中位 2048ms，**不劣于 before（2065ms）**。§9 既有门禁
  复测通过（TTI 3681ms < 8000；最长 Long Task 1063ms < 3000；搜索命中 1999）。
- 500 块 60fps：§9 复测 fps 中位 59.9、Long Task 0。
- 离线 4/4、verify-precache、全量单测（core 385 / web 393）零回退。
- `pnpm-lock.yaml` 零 diff、零外网请求、core 零 DOM/React、未碰 Cargo/Tauri/workflows。
