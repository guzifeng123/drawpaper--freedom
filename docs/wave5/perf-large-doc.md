# Wave5 性能：2000 块大文档加载 TTI 优化

## 1. 目标与口径

- **目标**：2000 块大文档加载 TTI 从 ~60s 降到 ≤15s（争取 ≤10s），且 500 块拖拽/滚轮 60fps 不回退。
- **TTI 测量口径**（`packages/web/e2e/performance.spec.ts` 常量 `TTI_2000_MAX_MS = 15000`）：
  从 `loadFixture`（= core `switchDoc`，单事务 set）触发开始，到同时满足：
  1. 视口内 `.react-flow__node` 已渲染；
  2. 一次画布交互（Ctrl+F 打开搜索面板）在 `INTERACTION_BUDGET_MS = 500ms` 内出结果。
  浏览器在 dev server 下 headless 采样；阈值用常量，文档同步说明。
- 刷新水化路径（从 Dexie 打开已存 2000 块文档）：headless 下受 IndexedDB 反序列化抖动影响较大，本次以 DEV `loadFixture` 路径为主断言；水化路径与 loadFixture 共用同一条 `switchDoc → buildSnapshot → RF 挂载` 热路径，瓶颈同源，优化收益一致，故不另加抖动敏感断言，保留 `__perfStages` 采样输出。

## 2. 瓶颈根因（带数据）

基线 LOAD_2000_MS ≈ **60749ms**，Long Tasks API 抓到单个 **58.2s** 长任务。二分定位：

| 排除项 | 验证动作 | 结论 |
|---|---|---|
| MiniSearch `buildIndex` | 采样 ~13ms | 非瓶颈 |
| core `switchDoc`/`loadDoc` | `switchDocSync` ~32ms | 非瓶颈 |
| MiniMap（即便 display:none） | 条件卸载后仍 59s | 非瓶颈（但大文档下仍关闭保护） |
| overlay 分页 `computePanelsPaginate` | 临时 short-circuit 后仍 59s | 非瓶颈 |
| 各面板（TopToolbar/Outline/TagFilter…） | 临时禁用后仍 59s | 非瓶颈 |
| ReactFlow `fitView` prop | 改 `fitView={false}` 仍 59s | 非瓶颈 |
| **RF 接收 2000 nodes** | 临时清空 nodes/edges 后 TTI 骤降 1.5s | **瓶颈在此** |
| nodes-only vs edges-only | edges 清空仍 59s | 是 **nodes** 不是 edges |

CPU Profiler 聚合 self-time 锁定热路径（76% 采样）：

```
BlockShell ResizeObserver report()
  → api.setMeasuredSizes(patch)            // create-editor-api 合并 patch
  → store.set(immer)                        // 每次尺寸上报都触发一次 store 写
  → zustand subscribe → cached = null       // 快照缓存失效
  → 每个挂载节点的 useSyncExternalStore 重新跑 selector
      useChildCount(blockId):
        doc.edges.reduce((n,e)=> e.source===blockId ? n+1 : n, 0)   // O(E=2000)
```

即：**每一次 ResizeObserver 上报 / 任何 store 通知，都让每个挂载节点对全量 ~2000 条 edges 做一次 reduce**。2000 边 × N 次通知 × 每个挂载节点 = 主线程几十秒。这是 O(V·E) 在每次通知上重复，而非一次性 O(E)。

## 3. 优化项与原理

### 3.1 一次性预计算子节点数映射（核心修复）
- core 新增纯函数 `buildChildCountMap(edges)`（`packages/core/src/graph/graph.ts`）：O(E) 一次扫边，`source=父` 计数。零 DOM，配 3 个单测。
- `EditorSnapshot` 新增可选 `childCount?: Record<string,number>`。
- `create-editor-api` 在 `buildSnapshot` 里计算该映射，并**按 `doc.edges` 引用缓存**（edges 引用不变就不重扫）。
- `useChildCount(blockId)` 从 O(E) reduce 改为 O(1) 读 `snapshot.childCount[blockId] ?? 0`。
- 效果：把「每次通知 × 每节点 × O(E)」降为「文档变更一次 × O(E)」。

### 3.2 大文档关闭 MiniMap 保护
- `CanvasEditor.tsx`：`doc.nodes.length <= MINIMAP_NODE_LIMIT(=300)` 才挂载 `<MiniMap/>`。MiniMap 为每个节点渲染一个 SVG 元素，2000 节点 = 2000+ SVG DOM；profile 证明它不是主因，但大文档下关闭是合理保护（小文档行为不变）。

### 3.3 保持不变的既有效能
- `onlyRenderVisibleElements` 已开：2000 块视口仅渲染 ~8 节点（500 块实测 8/500）。
- 非编辑态零 Tiptap 实例（StaticHtml 静态渲染），保持。
- 搜索索引 `buildIndex` 同步全量重建仅 ~12ms，不是瓶颈；保留现状，不引入分片（无必要）。

## 4. 前后对比

| 指标 | 优化前 | 优化后 |
|---|---|---|
| LOAD/TTI_2000_MS | ~60749 | ~6200（中位，3 次 6385/6215/6005） |
| 最长 long task | 58.2s（单个） | ~4.9s（首次挂载，随后 <500ms） |
| `switchDocSync` | ~32ms | ~37ms |
| `buildIndex` | ~13ms | ~12ms |
| 交互响应（Ctrl+F） | 不可用（主线程阻塞） | ~310ms（<500ms 预算） |
| 搜索最终命中 | — | 1999/2000 |
| 500 块拖拽/滚轮 fps | 60 / 60 | 60 / 60（不回退） |
| 视口渲染节点 | 8/500 | 8/500（不变） |

## 5. 风险与回退点

- **数据格式/持久化语义不变**：`.kbnote`、Dexie、assetRefs、快照/回收站未触碰。
- `childCount` 为 snapshot 可选字段；`buildChildCountMap` 是纯函数，edges 引用缓存按引用相等判断（immer 产生新引用才重算），语义与逐 reduce 完全一致。
- MiniMap 阈值 300：超过即不显示概览；小文档（<300）行为完全不变。回退 = 删除 `MINIMAP_NODE_LIMIT` 条件。
- 风险：若未来 edges 内容原地突变（非 immer 新引用），缓存会过期——当前 store 全走 immer 产生新引用，无此问题。

## 6. 遗留

- 首次挂载仍有 ~4.9s long task（主要是 RF 接收 2000 nodes 的内部 adoptUserNodes + 一次性 overlay 分页 `paginateTiles`），在 10s 预算内；进一步拆帧/分片属后续波次。
- 刷新水化路径（Dexie）未加自动化断言（headless 抖动），保留采样输出；热路径同源，收益一致。
- 代码分包（vite manualChunks）是后续另一波，本次未动 vite.config。
