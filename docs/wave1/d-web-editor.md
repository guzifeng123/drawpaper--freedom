# Wave1-D · Web 画布编辑层（React Flow + Tiptap 知识块）

> 范围：M0+M1 中除面板/导出/存储实现外的全部画布编辑体验。
> 所有权目录：`packages/web/src/editor/`（不依赖 `src/store`；通过结构型 `EditorApi` 接缝，Wave2 适配真实 store）。

## 1. 文件清单与职责

| 文件 | 职责 |
|---|---|
| `editor-api.ts` | **核心接缝**：`EditorApi` 结构型接口（state 切片 + 全部回调签名）、`EditorSnapshot`、`PendingConflicts`、`ConflictResolutionInput`、`LayoutGhost` |
| `mock-editor-api.ts` | `createMockEditorApi()`：zustand 内存假实现（增删改连 / 选择 / undo-redo / 冲突挂起裁决 / 简易树布局预览），组件在无真实 store 时完整可跑 |
| `content-defaults.ts` | 各块类型默认 Tiptap JSON、默认尺寸、纯文本提取 |
| `tiptap/createBlockEditor.ts` | 统一 editor 工厂：StarterKit(h1-3/bold/italic/strike/code/列表/quote/hr) + Underline + Highlight(多色) + TextStyle + Color + Link(autolink) + Placeholder + Image + TaskList/TaskItem；`getStaticExtensions()` 供静态渲染复用 |
| `tiptap/input-rules.ts` | Markdown 行首快捷规则（`# `/`## `/`### `/`- ` /`* `/`1. `/`[] `/`[ ] `/`[x] `/`> `/`--- `）；`matchMarkdownRule` 纯函数供测试 |
| `tiptap/slash-menu.tsx` | 行首 `/` 浮动命令菜单（块类型 9 项 + 行内格式 5 项），方向键/Enter/Esc/输入过滤，portal 到 body |
| `tiptap/static.tsx` | `StaticHtml`：Tiptap JSON → HTML（`generateHTML`，memo + 2000 条 LRU），非编辑态零 Editor 实例（500 块帧率关键） |
| `nodes/types.ts` | RF 节点 data 契约 `AppNode` |
| `nodes/BlockShell.tsx` | 通用外壳：选中描边、hover 工具条、NodeResizer（minWidth 160、文字块只调宽、图片块等比）、双击挂 Tiptap 编辑（nodrag/nowheel/stopPropagation）、ResizeObserver 实测高度上报、四向 Handle、折叠角标、pinned 指示、Esc 分层退出 |
| `nodes/block-hover-toolbar.tsx` | hover 工具条：块类型切换、8 色标签色点、置顶、折叠、复制、删除 |
| `nodes/blocks.tsx` | 7 种块的表现层：TextBlock / HeadingBlock(字号分级) / TodoBlock(勾选框+删除线) / BulletBlock / NoteBlock(暖色底) / ImageBlock(等比缩放 img) / GroupBlock(虚线圆角容器) |
| `nodes/index.ts` | `nodeTypes` 模块级常量 |
| `edges/ParentEdge.tsx` | 唯一边类型：贝塞尔 + 实心箭头、选中加粗、6 色浮层、双击标签内联编辑 |
| `edges/index.ts` | `edgeTypes` 模块级常量 |
| `state/interaction.ts` | 纯函数状态机：select/connect/pan/box-select/insert + editing；Esc 分层迁移表 |
| `state/useKeyboardShortcuts.ts` | 画布快捷键全集；composition 期间屏蔽 Tab/Enter/方向键；编辑中仅 Esc |
| `canvas/editor-context.tsx` | `EditorApiContext` + 粒度订阅 hooks（`useEditingNodeId` / `useChildCount` / `useSearchHighlight` 原始值订阅，视口平移不触发节点重渲染） |
| `canvas/CanvasEditor.tsx` | 主组件：受控 nodes/edges、折叠后代过滤、onConnect 校验（自环 toast / 重复边选中提示）、onConnectEnd 松手空白建子块、拖拽磁吸+参考线、双击空白建块、右键建块、MiniMap/Controls/点阵、ghost 叠加层、lastFocus 飞块、自定义缩放控件 |
| `ui/ConflictDialog.tsx` | Radix Dialog：多父单选主父 / 成环选断边 |
| `ui/toast.tsx` | 轻提示 toast（自环/重复边等） |
| `lib/geometry.ts` | 纯几何：拖拽磁吸（左/中/右、上/中/下三参考线，阈值 6px）+ 网格磁吸 |

## 2. EditorApi 完整签名（供 Wave2 适配真实 store）

见 `editor-api.ts`。要点：

- **只读切片**：`doc / selection:Set / editingNodeId / mode / viewport / layoutPreview / pendingConflicts / searchHighlight / saveState / prefs{gridSnap} / lastFocus`。
- **订阅**：`getState() / subscribe(fn)`（useSyncExternalStore 三件套；mock 已做快照缓存，真实 store 直接 zustand selector 适配即可）。
- **回调**：addNode / addNodes / addImageBlock / deleteNodes / updateContent / setBlockType / moveNode / resizeNode / setMeasuredSizes / addEdge(自动挂起冲突) / deleteEdge / setEdgeColor / setEdgeLabel / tabAddChild / enterAddSibling / shiftTabDemote / togglePin / toggleCollapse / toggleTodo / setBlockStyle / setSelection / setMode / setEditingNode / setViewport / copy/cut/paste/duplicate / undo/redo / previewLayout/confirmLayout/cancelLayout / resolveConflicts/cancelConflicts / setGridSnap / openSearch / openExport / save。

## 3. 已实现交互对照（§4.2–§4.6）

- **§4.2 块**：7 种块类型 ✅；行内格式（粗/斜/下/高亮/颜色/链接）✅；Markdown 快捷输入 ✅；斜杠菜单 ✅；粘贴 URL 成链（Link autolink）✅、粘贴剪贴板图片 → dataURL 新 image 块 ✅；拖拽移动、四角缩放（min 宽 160、文字回流、高度实测）✅；8 色标签 ✅；多选（框选/Cmd 点选）✅；复制/剪切/粘贴 ✅；双击进编辑、点外部提交卸载 ✅；对齐参考线/网格磁吸（开关由 prefs.gridSnap）✅；折叠角标+折叠后代剔除 ✅；pinned ✅。
- **§4.3 边**：Handle 拖出连线、松手空白自动建子块 ✅；自环禁止 toast ✅；重复边选中提示不重建 ✅；拖回源块/Esc 取消 ✅；**按 override：仅父子有向边，6 色边板（core EDGE_COLORS + DEFAULT_EDGE_COLOR，零硬编码）✅**；自由标签双击编辑 ✅。
- **§4.4 画布**：无限平移缩放（以指针为中心 RF 原生）✅；点阵背景 ✅；MiniMap（pannable/zoomable）✅；框选 ✅；双击空白建块 ✅；右键菜单（confirm 建块占位）✅；适应屏幕/1:1 缩放控件（百分比显示）✅；lastFocus 飞块高亮 ✅。
- **§4.5 整理画布侧**：`previewLayout()` → 半透明 ghost 叠加层（layout-ghost 节点）✅；`confirmLayout` 落位（节点 position 直接走 doc，250ms 过渡留 CSS 钩子位置）✅；Esc/取消 ghost 消失 ✅；冲突弹窗（多父选主父/成环选断边，绝不静默）✅。
- **§4.6 状态机/快捷键/输入法**：状态机 Esc 分层 ✅；Tab 子块 / Enter 兄弟 / Shift+Tab 升级 / `/` 行首菜单 / Cmd+K 链接（菜单内）✅；Ctrl+S/Z/Y/D/G/F/P、Delete、F2、Ctrl+0/1/A、方向键微移、V/C 模式键 ✅；composition 期间屏蔽已单测 ✅。
- **§9 性能**：onlyRenderVisibleElements ✅；节点/边 React.memo ✅；非编辑态纯 HTML 不建 Editor ✅；粒度订阅避免视口平移触发全量重渲染 ✅。

## 4. 测试清单（vitest，39 用例全绿）

- `state/interaction.test.ts`（6）：状态机迁移表 + Esc 分层。
- `state/useKeyboardShortcuts.test.tsx`（3）：Tab 建块、composition 屏蔽、编辑中屏蔽。
- `lib/geometry.test.ts`（5）：磁吸阈值、中线对齐、网格。
- `tiptap/input-rules.test.ts`（15）：11 条 Markdown 规则表 + 斜杠菜单过滤。
- `mock-editor-api.test.ts`（9）：增删改、自环忽略、多父/成环挂起、裁决、undo/redo、todo、Tab 建子。

## 5. 500 块临时挂载验证

- 方式：临时改 `App.tsx` 挂 `<CanvasEditor api={500 树 fixture} />`（已还原）。
- 现象（截图 `/tmp/dweb-shots/initial.png`、`/tmp/dweb-shots/after-pan.png`）：
  - 视口内 DOM 节点数 ~94（`onlyRenderVisibleElements` 虚拟化生效，480 块只渲染可见区）；
  - 控制台零报错；贝塞尔箭头、点阵背景、MiniMap、缩放控件均正常；
  - 滚轮平移后场景正确滚动（after-pan 截图可见不同块）。
  - 帧率 rAF 粗测在无头环境被节流（读数 ~2，非真实终端帧率）；真实性能以真机为准，手段已按 §9 配齐。

## 6. 遗留问题 / 交接

- 一键整理的 250ms 落位 CSS transition：落位数据通路已通（ghost→confirm），过渡动画样式留待与真实布局引擎（Wave1-B）对接时在节点 transform 上加 class。
- 右键菜单当前是 `confirm()` 占位；正式菜单（新建/复制/粘贴/删除/置顶/改色）等 Wave1-E 面板体系。
- `setMeasuredSizes` 当前直接写 doc.height（mock 非撤销）；Wave2 真实 store 应将其作为派生量、不进 undo 栈。
- 斜杠菜单「块类型切换」直接换节点类型并重置内容（mock 简化）；真实 store 可保留内容迁移。
- `lastFocus` 消费已实现；搜索面板（Wave1-E）只需 set `searchHighlight` + `lastFocus`。
