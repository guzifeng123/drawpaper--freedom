# Wave4 · P1 总装集成（feat/integration-p1）

> 基线 develop `d506833`（Wave3 五路 f/g/h/i/j 已合入）。
> 本分支把 Wave3 留下的全部结构型桩接成真实 store / AI / 导出闭环。

## 1. 接线矩阵（桩 → 真实动作）

### 1.1 wiring/create-panels-api.ts（H 的 179–216 行桩全部替换）
| PanelsApi 字段/回调 | 接真实 store 动作 | 备注 |
|---|---|---|
| tagFilter (getter) | `store.tagFilter` `{tagIds,types,colors,match}` | 形状整形：`types→blockTypes` |
| setTagFilter | `store.setTagFilter({tagIds,types,colors,match})` | `blockTypes→types` |
| clearTagFilter | `store.clearTagFilter()` | |
| focusNodeId / setFocusNode | `store.focusNodeId` / `store.setFocusNode` | |
| activeFile | `store.activeFile` | |
| openLocalFile / saveAsLocalFile | `store.openLocalFile` / `saveLocalFileAs` | fsa 注入已在 editor-store.ts |
| createTag/renameTag/setTagColor/deleteTag | `store.createTag/...` | |
| reparentNode | `store.reparentNode(nodeId,newParentId,index)` | |
| addChildBlock / addSiblingBlock | 适配层组合 `addNode+updateContent+addEdge` | store 无对应原子动作，用现有动作组合，返回新块 id |
| snapshots / trash (getter) | `store.listSnapshots/listTrash` | **异步桥接**：模块级缓存 + ui nonce 驱动重渲染 |
| takeSnapshot/restoreSnapshot | `store.snapshotDoc/restoreSnapshot` | 完成后清缓存 dirty |
| deleteSnapshot | `storageAdapter.deleteSnapshot` | |
| restoreFromTrash/purgeFromTrash/emptyTrash | `store.restoreTrash/purgeTrash/emptyTrash` | |
| createDocFromTemplate | `store.createDocFromTemplate(id)` | templates 注入已在 editor-store.ts |

**关键修复（防死循环）**：`createPanelsApi` 每次 App 渲染都重建（getter 读最新值）。
初版把快照/回收站缓存放在工厂闭包里，导致每次渲染重置 `dirty=true` → 异步加载 →
`bumpNonce` → 再渲染 → 死循环（e2e 点击 pane actionability 超时）。
改为**模块级缓存**（单例 editorStore，进程内唯一），dirty 跨渲染保持。

### 1.2 wiring/create-editor-api.ts（I 标为可选的新字段/回调）
- snapshot 增：`focusNodeId`、`tagFilter{mode:match,tagIds}`、`manualFixed: manuallyMoved`。
- callbacks 增：`reverseEdge→store.reverseEdge`、`setFocusNode`、`setTagFilter`、
  `putImageAsset(file)→store.putImageAsset(file)`（OPFS 资产管线）。

### 1.3 AI 闭环（新建 wiring/create-ai-api.ts）
- `AiApi.applyAISuggestions`：**形状桥接** core/ai `AiSuggestion{kind,source,target,...}`
  → store adapters `AISuggestion{type,proposedEdges,nodeIds,text,...}` 逐条翻译后落库；
  成功自动 `previewLayout()`（J §5.4）。
- `addManualPageBreak/removePageBreak` → store 同名动作。
- AiClient 已就绪（buildAiMessages/validateAiOutput + OpenAICompatProvider，
  配置 localStorage `drawpaper.ai.config.v1`），本分支仅替换 createMockAiApi 为真。

## 2. App.tsx 总装
- 挂载 `OutlinePanel`（**默认折叠**，工具栏「大纲」按钮开关——避免遮挡建块区）、
  `TagFilterBar`、`AiPanel`（右侧浮层，工具栏「AI 辅助」按钮开关）。
- 订阅 store 新切片 `focusNodeId/tagFilter/activeFile/manuallyMoved` 驱动重渲染。
- 工具栏加第 4 个布局按钮「放射 radial」；加大纲/AI 开关按钮；主题三态（lib/theme.ts）。
- ExportDialog 增「矢量 SVG」「Markdown」按钮（useExportModel 接 buildPagesSvg/docToMarkdown）。

## 3. 配置修改
- `vite.config.ts`：PWA workbox `maximumFileSizeToCacheInBytes` 提到 4MiB
  （接入大纲/标签/AI 后单 chunk 2.1MB 超默认 2MiB 预缓存上限）。
- `wiring/ui-store.ts`：增 `snapshotsNonce/trashNonce/aiPanelOpen/outlineOpen`。
- `wiring/dev-hooks.ts`：白名单增 P1 动作（createTag/setTagFilter/reparentNode/...）供 e2e。

## 4. 验收数字
- `pnpm -r build` / `typecheck`：绿。
- `pnpm lint`：0 error（3 warning 全在无关的 apps/mobile-capacitor）。
- `pnpm -r test`：core 122 + web 168，不回归。
- `npx playwright test`：14 passed（既有 10 + 新增 p1.spec 4）。
- 生产 dist 无 `__drawpaper__` DEV 钩子、无外网请求。

## 5. 新增 e2e（e2e/p1.spec.ts）
1. 标签筛选：createTag + setTagFilter → 节点仍在、清除。
2. 放射 radial：点「放射」→ 整理预览 → 应用 → 节点可见。
3. 深色：主题选深色 → `.dark` → reload 后持久。
4. AI：route.fetch mock 返回 add-edge → 合入 → doc.edges.length=1。

## 6. 截图（/tmp/p1-integration-shots/）
- light-main-outline.png（浅色 + 大纲）
- ai-panel.png（AI 面板）
- export-dialog.png（导出弹窗新选项）
- dark-main.png（深色主界面，4 布局按钮 + 分页虚线）

## 7. 遗留 / 已知缺口（留给 Wave2b/P1 后续）
- PageBreakOverlay 手动分页符的右键插入/拖拽/删除交互（J §5.5）未接——
  store 动作已就绪（addManualPageBreak/removePageBreak），仅缺 overlay 拖拽 UI。
- 表格行列操作菜单、长按 Handle 连线手势精细拦截（i §6）未做。
- 快照/回收站列表在弹窗打开时才异步加载（非实时 push），刷新逻辑够用但非实时。
- 2000 块加载 ~60s（性能 e2e 记录 LOAD_2000_MS），大文档体验待优化。
- 大纲面板与文档列表的视觉间距未精调。
