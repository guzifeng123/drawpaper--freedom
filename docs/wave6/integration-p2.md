# Wave7 · P2 总装集成（feat/integration-p2）

> 基线 develop `ddefa21`（schema v2）。三路 P2 功能分支合入：
> - `feat/p2-cross-doc-links` (fc24622)
> - `feat/p3-graph-overview` (2504f4b)
> - `feat/p2-canvas-advanced` (a66d8c3)

## 1. 冲突裁决
仅 1 处真实冲突：`packages/web/src/wiring/dev-hooks.ts`。
- 三处冲突块全部保留：links 的 `currentLinks/exportCurrent/backlinksTo` 与 overview 的
  `mountOverviewDev/unmountOverviewDev` 并存；import 同时引入 `loadBacklinks` 与
  `mountOverviewDev/unmountOverviewDev`。
- `core/src/index.ts`、`BlockShell.tsx`、`store.ts`、editor 扩展注册均自动合并无冲突。

## 2. 总装清单（桩 → 真实挂载）
### 跨文档双链
- App 挂载期 `useEffect` 注册 `setDocRefClickHandler(attrs=>openDoc+flyTo+高亮)` +
  `installDocRefClickDelegate()`，卸载时清理。
- BacklinksPanel 挂载为右侧可折叠浮层（工具栏「反链」按钮，ui-store `backlinksOpen`）；
  块级维度走 `backlinksNodeId`（已在 ui-store）。
- `openDocRef` 已在 create-panels-api 接真实 store（同文档 flyToNode，跨文档 openDoc→flyToNode）。

### 全局图谱总览
- 工具栏「全局图谱」按钮 → `ui-store.overviewOpen` → App 全屏挂载
  `<OverviewCanvas provider={<DexieOverviewProvider/>} onOpenDocNode={openDoc+flyTo+高亮} onClose={...}/>`。
- provider 引用稳定（useMemo）。

### 画布余项
- 边弯折点/拖入/target 长按三路已在画布内接线；总装仅回归（setEdgePoints 走真实命令栈、
  txt/图片/附件拖入、target 长按 addEdge），e2e canvas-advanced.spec.ts 3 例全过。

### ui-store 新增
`backlinksOpen` / `overviewOpen`（纯 UI 态开关）。

## 3. 关键修复
- **overview e2e 夹具**：overview 分支夹具用声明式 `links:[]` 喂数据，但 links 分支的
  flushSave 在保存时用 `extractDocLinks` 从 Tiptap docRef mark 重建 links——无 mark 的声明式
  links 被清空，导致总览无 docref 虚线。修复：在夹具 a1 节点正文里放真实 docRef mark，
  使重建管线能抽到链接。这是 merge 后才暴露的跨分支交互，非任一单分支 bug。

## 4. 门禁数字
- `pnpm -r build`：绿，无 chunk 超限警告，precache 校验通过。
- `pnpm typecheck`：绿。
- `pnpm lint`：0 error。
- `pnpm -r test`：core **165**（140 基线 +25）、web **199**（178 基线 +21），只增不减。
- `npx playwright test`：**41 passed**（32 基线 + links 1 + overview 5 + canvas 3），干净单跑全绿。
  - 2000 块 TTI 6.7s（≤15s）；500 块拖拽 60fps。

## 5. 截图（/tmp/p2-integration-shots/）
- main-canvas.png（主画布两节点）
- graph-overview.png（全局总览：搜索/折叠/展开/关闭 + 文档簇节点）

## 6. 补做闭环（复核反馈）
### 悬挂 chip 红虚边
- `doc-ref-mark.ts` 增模块级 `danglingTargets: Set<key>` + `setDanglingTargets` / `applyDanglingClasses(root)`；
- App 在 `doc.links 重建指纹 / currentDocId / docs 列表指纹` 变化时，用 core `findDanglingLinks(currentDoc.links, db.docs 全量)` 计算悬挂 key 集合并写入；
- MutationObserver 监听 body，虚拟化滚动进视口的新 chip 也会被补 class。

### 删除确认列反链影响
- PanelsApi 新增 `docDeleteImpact(docId)`：`db.docs` 全量 + `linksAffectedByDeleteDoc` 取 incoming，样例格式 `《来源文档》块「正文摘要」`；
- DocsListPanel 删除按钮点开时异步拉 impact，ConfirmDialog 增 children 渲染影响清单（>0 红框列出，0 提示无引用，加载中提示）；取消不删。

### 新增 e2e（cross-doc-links.spec.ts，+2）
- 删除目标文档后 chip 出现 `.is-dangling` 且链接记录保留；
- 删除被引用文档确认框含影响数量文案 → 取消不删 → 确认后删除。

## 7. 门禁（补做后）
- build / typecheck / lint 0 error；core 165 / web 199 单测；e2e **43 passed**（41 +2）。

## 8. 已知遗留
- 删除**块**（而非文档）的确认弹层接 `linksAffectedByDeleteNode`：块删除走快捷键无确认框，留后续。
- 图片拖入走 dataURL 内联，OPFS 压缩管线未接图片（canvas-advanced 自述遗留）。
