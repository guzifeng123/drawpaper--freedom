# Wave6b — 全局知识图谱总览（Graph Overview，只读 P3 视图）

> 只读跨文档知识图谱总览：把全部文档的块聚合成一张大图，支持文档级折叠/展开、
> 大图自动采样（折叠到文档簇）、轻量布局、搜索定位、点击块跳转回文档。
> 全部 core 逻辑为纯函数零 DOM；web 为只读 @xyflow/react 画布。

## 1. 数据模型（core `packages/core/src/overview/`）

输入 `OverviewDocInput[]`：每份文档 `{ id, title, nodes[], edges[], links[] }`。
- `nodes[]`：`{ id, type, label }`（label 由 web 侧从 Tiptap content 抽取，core 不解析富文本）。
- `edges[]`：文档内父子边（`source`/`target` 为块 id）。
- `links[]`：`DocRefLink`（schema v2，`sourceDocId/sourceNodeId/targetDocId/targetNodeId`）。

聚合输出 `OverviewModel`：
- `OverviewNode.id` 全限定 id（fqid）：
  - 块：`b:<docId>::<nodeId>`
  - 文档簇：`d:<docId>`
- `OverviewNode`：`{ id, docId, kind: 'block'|'doc', title, blockType? }`。
- `OverviewEdge`：`{ id, source, target, type: 'parent'|'docref' }`。
  - `parent`：文档内父子边。
  - `docref`：跨文档双链（也允许文档内 `[[link]]`）。
- `OverviewDocMeta`：`{ docId, title, nodeCount }`。

聚合为**两遍**：第一遍登记所有文档的块 fqid，第二遍再发射节点与边——
这样跨文档 `docref` 的端点即便在排序上靠后出现也不会被丢弃。

## 2. 折叠 / 展开

- `computeView(model, collapsedDocIds: ReadonlySet<string>)`：
  - collapsed 的文档 → 输出一个文档簇节点，其内部块不出现；
  - 未 collapsed 的文档 → 输出其全部块节点；
  - 边按端点是否在视图内重映射：若某端点属于 collapsed 文档，改连到该文档簇节点。
- `collapseToDocs(model)`：全部文档聚成簇（仅保留簇间 docref）。
- `expandDoc(set, docId)` / `collapseDoc(set, docId)`：对 collapsedDocIds 集合的纯函数操作（幂等）。

## 3. 大图采样（确定性）

`maybeCollapseForScale(model, collapsed, softLimit = OVERVIEW_NODE_SOFT_LIMIT = 600)`：
- 当展开后可见节点数 > 阈值时，自动折叠到文档簇，返回 `{ view, collapsed: true }`；
- 否则返回 `{ view, collapsed: false }`。
- 纯函数、确定性（同输入同输出）。这是软上限：折叠后簇数量 = 文档数，
  文档极多时由布局圆周长自然分散，不再递归折叠。

## 4. 轻量布局（铁律：禁止 d3-force / dagre / elkjs）

`layoutOverviewView(view)` → `Record<nodeId, {x,y}>`：
- 按 docId 归集视图中的节点（簇节点 + 展开块）；
- 文档簇按 docId 字典序均匀摆在半径 `clusterRadius` 的圆上（单文档居中）；
- 展开文档的块以该文档圆心为起点，按 `blockGridCols` 列网格铺开；
- 确定性（按 id 排序），无重叠（网格单元格固定）。

常量 `OVERVIEW_LAYOUT`：clusterRadius / center / blockCellW/H / blockGridCols。

## 5. 搜索

`searchOverview(model, query)` → `{ matchedBlockIds, recommendedDocIds }`：
- 小写子串匹配块 label 与文档标题；
- 空查询返回空。web 侧据此高亮命中块、弱化未命中块、推荐展开所属文档。

## 6. web 组件（`packages/web/src/overview/`）

- `OverviewProvider` 接口：`loadAllDocs(): Promise<KBNoteDoc[]>`。
  - `DexieOverviewProvider`：只读 `db.docs.orderBy(':id').toArray()`，不写表、不改表结构。
  - `MockOverviewProvider` + `makeMockDoc`：组件测试 / 开发预览。
- `OverviewCanvas`：只读 ReactFlow 画布。
  - 节点按文档着色（`DOC_GROUP_PALETTE` 8 色循环，字典序取色；UI 注明「文档分组色」，
    区别于边色常量体系）。
  - `docref` 边：虚线 + 动画（`strokeDasharray`）；`parent` 边：实线。
  - `onlyRenderVisibleElements` 虚拟化，保证 2000+ 总量流畅。
  - 顶部搜索框；点簇节点 → 折叠/展开；点块节点 → `onOpenDocNode(docId, nodeId)`。
  - 挂载时若 >600 节点自动折叠并显示提示。
- `dev-mount.tsx`（DEV-only）：`mountOverviewDev()` 把总览挂到全屏 fixed 容器，
  供 e2e/截图；`unmountOverviewDev()` 卸载。

## 7. Wave7 接缝

- 正式挂载：Wave7 在 App/路由中渲染 `<OverviewCanvas provider={<DexieOverviewProvider/>} onOpenDocNode={(docId,nodeId)=>openDoc+flyTo+高亮} />`。
- `onOpenDocNode(docId, nodeId)`：跳转文档 + flyTo 该块节点 + 高亮。
- 文档簇点击 = 展开/折叠（组件内部已实现）。
- DEV 钩子（`window.__drawpaper__.mountOverviewDev/unmountOverviewDev`）已在
  `wiring/dev-hooks.ts` 追加，仅 `import.meta.env.DEV` 下存在，生产 tree-shake。

## 8. 测试清单

### core 单测（`overview.test.ts`，15 例）
- 聚合：fqid 块节点、parent/docref 边、缺失端点丢弃、确定性。
- 折叠/展开：展开视图、collapseToDocs、部分折叠、expand/collapse 幂等。
- 采样：阈值内不折叠、超阈值折叠到簇、确定性。
- 布局：每节点有坐标、坐标互不相同、确定性。
- 搜索：匹配块 label / 文档标题、空查询。

### web 组件测试（`overview.test.tsx`，4 例）
- 两组块节点渲染；点击块触发 onOpenDocNode；搜索高亮；
- 大集合（900 块）自动折叠提示。

### e2e（`e2e/overview.spec.ts`）
- 两组块节点 + 一条跨文档虚线可见；
- 折叠后只剩两个簇节点；
- 搜索定位；
- 点击块触发 `__lastOpenDocNode`；
- 2100 块多文档：自动折叠提示、TTI ≤ 15s（主画布同口径）、
  DOM 渲染节点 < 20（虚拟化生效，实际只渲染 3 簇节点）。

## 9. 边界

- 只新增 `core/src/overview/`、`web/src/overview/`；`storage/`、`store`、`panels`、
  App 业务文件未改；App.tsx diff 为空（Wave7 正式挂载）。
- 不引入 d3-force / dagre / elkjs；不新增依赖（d3-hierarchy 已在 core）。
- core 零 DOM；web 只读画布不写 IndexedDB。
