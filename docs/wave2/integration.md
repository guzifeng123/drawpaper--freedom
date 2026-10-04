# Wave2a 集成（M1 P0 闭环）

> 范围：把 Wave1 五路（core model/graph/serialize、layout/paginate、store+浏览器存储、web 画布编辑器、web 面板/导出）从「结构型接口/mock 独立开发」接成一个真正跑通 P0 完整闭环的应用，并收掉跨模块构建/lint 口。
> 本分支：`feat/integration-m1`（基于 develop @ 5eb2331）。

## 0. 收口门禁

| 命令 | 结果 |
| --- | --- |
| `pnpm -r build` | ✅ core + web（含 PWA） |
| `pnpm typecheck` | ✅ |
| `pnpm lint` | ✅ 0 error（exhaustive-deps 为 warn，5 处 disable 均必要） |
| `pnpm -r test` | ✅ core 78 + web 75，无回归 |
| `npx playwright test` | ✅ e2e/smoke-m1 3/3 |

## 1. 先修的构建 / lint 口（合并后实测）

### 1.1 web tsc 4 处跨分支契约不一致
- `PrintSheets.test.tsx` 两处 `PageSheet` 夹具缺 `pageNumber`（core B 已把它设为必填）：按 B 最终类型补 `pageNumber: 1/2`。
- `PrintSheets.test.tsx` 的 `makeResult()` 缺 `notes: []`（PaginateResult 必填）：补空 notes。
- `useExportModel.ts` 两处 fallback `PaginateResult` 缺 `notes`：补齐。

### 1.2 lint 6 error
- 5 处 `react-hooks/exhaustive-deps` rule not found：根 devDeps 安装 `eslint-plugin-react-hooks@^7`，flat config 对 `packages/web/**/*.{ts,tsx}` 启用经典两条（`rules-of-hooks: error`、`exhaustive-deps: warn`）。**未**启用 v7 的 React Compiler 新门禁（set-state-in-effect / immutability）——那些会要求重写 Wave1 既有组件，超出集成范围。core 的 DOM-free 门禁不受影响。逐一核对 5 处 disable 均仍必要（lastFocus 飞块、Tiptap editor 生命周期、ResizeObserver、快捷键 effect、slash-menu），全部保留。
- `export/filename.ts:12 no-control-regex`：文件名清洗确实需要剔除 `\x00-\x1f`，加最小范围行内 `eslint-disable-next-line` 并注释理由。

## 2. 新建 `packages/web/src/wiring/` 适配层

总装核心：把真实 store 接到两套结构型接口。

- `ui-store.ts`：纯 UI 态 zustand（`exportOpen / searchOpen / activeSearchIndex`）。不进 undo、不持久化。EditorApi 的 `openSearch/openExport` 与 PanelsApi 的面板开关在此落地。
- `conflict-bridge.ts`：把 store 注入的 `deps.resolveConflictUi(pending)`（返回 Promise）与画布 `ConflictDialog`（调 `api.resolveConflicts / cancelConflicts`）桥接。弹窗期间新冲突先按取消收尾，不重弹；`cancelConflicts()` resolve(null) → store 按 §6 精确回滚本次触发边。
- `create-editor-api.ts`：真实 EditorStore → EditorApi。
- `create-panels-api.ts`：真实 store + ui + storage/host → PanelsApi。

### 2.1 EditorApi 适配决策（形状整形）
- `layoutPreview`：store 只给 `{x,y}`，适配层按 `measuredSizes / 节点宽高` 补成 `LayoutGhost{x,y,width,height}`（CanvasEditor 消费形状）。
- `pendingConflicts`：store 字段 `triggerEdgeIds` → EditorApi `provisionalEdgeIds`；multiParents/cycles 子结构一致，直传。
- `lastFocus`：store `nonce` → EditorApi `ts`（每次 ++ 即触发飞块动画）。
- `prefs`：`snapToGrid` → `gridSnap`。
- `setMeasuredSizes`：EditorApi 允许只报 `{height?}`；以 store.measuredSizes 为底做合并（宽度缺省取已有/默认），再整体回写 store，避免只报 height 清掉其它块的测量。
- `getState()` 引用稳定：store 每次 set 令快照缓存失效重算一次，两次通知间返回同一对象引用——满足 `useSyncExternalStore`，杜绝 "Maximum update depth"。
- `openSearch/openExport/save` → ui store / `requestSave()`。

### 2.2 core store 新增 action/state（语义属于状态内核）
见 `packages/core/src/store/store.ts`：
- `addImageBlock(dataUrl, x, y): string`——粘贴/插图 P0 走 dataURL，建 image 块并选中。
- `setBlockType(id, type)`——斜杠菜单/hover 工具条换块类型，内容重置为该类型空稿、尺寸取默认，undo 可回退。
- 复用既有 `DEFAULT_NODE_SIZES / EMPTY_TIPTAP_DOC`；`emptyDocData()` 用 JSON 克隆（core 禁 structuredClone）。
- 其余 EditorApi 回调（setEdgeColor/setEdgeLabel/对齐/lastFocus/flyTo 等）store 已具备，直接映射，未改签名。

### 2.3 PanelsApi 适配决策
- getters 读最新 store/ui（`docs/currentDocId/doc/saveState/savedAt/selectedNodeIds/layoutPrefs/branchOnly/canUndo/canRedo/page/exportOpen/searchOpen/searchQuery/searchResults/activeSearchIndex`）。
- `searchResults`：store 只给 `{nodeId,snippet}`，适配层补 `nodeType/matchStart/matchLength/score`（matchStart = query 在 snippet 中的位置）。
- 文档回调：`newDoc/duplicateDoc/removeDoc/openDoc/requestSave` 直调 store；`renameDoc` 对当前文档走 `store.renameDoc`，非当前文档直改 Dexie 记录后 `listDocs()`。
- `importKbnote(File)`：`file.text()` → `parseKBNote` → `loadDoc`，失败 toast 报错。
- `exportKbnote`：`requestSave()` → `exportKBNoteText()` → host `showSaveFilePicker(title.kbnote, text)`。
- 布局/页面回调直调 store。

### 2.4 toast 决策（二选一记录）
统一为**一套**：editor 内 `toast(msg)`（`editor/ui/toast.tsx`）改为委托面板侧全局 `pushToast('warn', msg)`；App 只挂一次 E 的 `<Toaster/>`。删除 CanvasEditor 里的 `<ToastHost/>`。冲突提示、自环/重边警告与导入导出/保存错误共用同一条 toast 队列。

## 3. App.tsx 总装
- `editorApi` 用 `useMemo` 稳定（useSyncExternalStore 要求 subscribe 不变）；`panelsApi` 每次渲染重建（getter 读最新值，新引用驱动 memo 面板重渲染）。
- App 订阅 store 切片（doc/saveState/canUndo/canRedo/docs/currentDocId/searchQuery/searchResults/layoutUi/viewport/layoutPreview）与 wiring ui（exportOpen/searchOpen/activeSearchIndex）以驱动面板重渲染。
- 挂载：CanvasEditor（真实 EditorApi）、TopToolbar、DocsListPanel、SearchPanel、ExportDialog、`useExportModel` 产出的 PrintSheets（sheetsVisible 时）、PageBreakOverlay（showPageBreak 时）、Toaster。
- **一键整理确认条**：`layoutPreview` 非空时浮「整理预览 / 应用 / 取消」，调 `editorApi.confirmLayout()/cancelLayout()`（Wave1-D 未留确认入口，补在 App）。
- **落位动画**：`index.css` 加 `.react-flow__node { transition: transform 250ms ease; .dragging { transition:none } }`；CanvasEditor 在 ghost 消失（应用/取消）后 280ms `fitView`，让布局结果进入视野。

## 4. 数据流闭环
- **测量回路**：BlockShell ResizeObserver → `api.setMeasuredSizes`（只报 height）经适配层合并落 store.measuredSizes；布局引擎据此排版。
- **布局闭环**：工具栏 `pickLayout(mode)` → `setLayoutMode + previewLayout()` → ghost 预览（适配层整形 LayoutGhost）→ 应用 `confirmLayout()`：250ms transition 落位、单次 undo 整体回退、pinned/collapsed 由 core 保留；多父/成环走 ConflictBridge 弹窗。
- **导出闭环**（`useExportModel` 真实化）：
  - fit/tiles：以当前画布节点坐标作为 LayoutResult 输入分页（所见即所得）；
  - flow：先 `layoutTree(mindmap-down)` 再 `paginateFlow`；
  - settings 全量接 `doc.page`（方向/边距/页眉页脚页码/黑白/pageOrigin/三模式）；
  - 打印（window.print，矢量）、PNG（html-to-image pixelRatio≈3）、PDF（pdf-lib 合成）三按钮端到端打通；文件名 `buildExportFileName` = `{标题}_{YYYYMMDD}_{纵|横}.pdf`。
  - **修**：屏幕上 `.drawpaper-print-container` 是 `display:none`，html-to-image 抓不到——位图导出前临时把容器移到屏幕外可见（fixed/left:-100000px），抓完恢复。
- **搜索闭环**：MiniSearch 索引 → SearchPanel 结果 → Enter `flyToNode` → store.flyToNode → lastFocus → CanvasEditor setCenter 飞块高亮。
- **文档闭环**：新建/重命名/复制/删除/切换/自动保存 500ms 文案；.kbnote 导入校验失败 toast；导出 .kbnote；刷新从 Dexie 恢复（已冒烟验证）。
- **图片**：P0 dataURL，`addImageBlock` 落 store。

## 5. 对 Wave1 模块的最小修复（超出适配层的部分）
- **CanvasEditor 双击建块**：React Flow v22 不把 `onDoubleClick/onContextMenu` 透传到 pane（实测原生事件到了 window 但 React 合成 handler 不触发）。改用包装 div 上的**捕获阶段**原生监听（`addEventListener('dblclick', fn, true)`），双击建块后 `setEditingNode(id)` 立即进入输入态。右键菜单同改。
- **CJK 搜索分词**：MiniSearch 默认把整段中文当一个 token，子串搜不到。`search-index.ts` 加 CJK 友好 tokenizer（拉丁整词、CJK 逐字），index 与 query 两侧都用。
- **d.ts 夹具**：按 core B 最终类型补 `pageNumber/notes`。

## 6. 已知缺口（留给 Wave2b / P1）
- 边标签开关（ExportDialog 本地 `edgeLabels` state）未写回 PageSettings，位图导出默认 `showEdgeLabels:true`；页面设置里的边标签开关接线待补。
- docs 列表新建文档后需刷新才出现在侧栏（autosave 后未主动 listDocs）；新建即刷新侧栏留待 Wave2b。
- 撤销布局后相机不回位（节点 off-screen 被 onlyRenderVisibleElements 卸载，数据未丢）——undo 后 fitView 可补。
- `duplicateDoc/renameDoc` 对非当前打开文档走 storage 直改，未做 toast 反馈。
- 大纲面板、深色/浅色、OPFS UI、AI、图片拖拽缩放、OPFS 等 P1 项未做。

## 7. 冒烟证据
- 关键截图：`/tmp/wave2a/`（10-build / 11-layout-ghost / 12-layout-applied / 13-search / 13b-search-flyto / 14-export / 20-after-reload / 导出 PNG / 导出 PDF）。
- 无头浏览器实测：PNG 下载 178KB（2382×3369）、PDF 34KB 有效；刷新后文档从 Dexie 恢复；首屏无 console error、无 Maximum update depth。
- 稳定主路径沉淀为 `e2e/smoke-m1.spec.ts`（建块 / Ctrl+F 搜索命中 / Ctrl+P 导出三模式）。
