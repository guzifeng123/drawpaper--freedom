# Wave3-I · P1 新块类型 / 触屏手势 / 边增强 / 聚焦与筛选视觉

> 范围：`packages/web/src/editor/` 内的 P1（Wave3 第一批）。
> 分支：`feat/p1-blocks-touch`（基于 develop 3a44caf）。
> 并行接缝：store 真实动作（reverseEdge / setFocusNode / setTagFilter / putImageAsset / manualFixed）由存储/布局 agent 同期实现；本侧只扩展 `editor-api.ts`（新字段/回调**可选**）+ `mock-editor-api` 全量假实现，Wave4 接真实 store。

---

## 1. P1 新块类型

| 块 | nodeTypes key | 编辑方式 | 默认尺寸（editor 侧覆盖 core 回退） |
|---|---|---|---|
| 表格 table | `table` | 块内 Tiptap Table（table/row/cell/header），Tab 跳格走扩展自带 | 340×150 |
| 代码 code | `code` | 块内 Tiptap CodeBlockLowlight；语言下拉（11 种） | 320×130 |
| 公式 equation | `equation` | 双击 textarea 编辑 LaTeX 源码（`$...$` 自动剥离） | 260×84 |
| 网页书签 bookmark | `bookmark` | 双击表单编辑 url/title/description；点击新标签打开 | 300×96 |
| 附件 attachment | `attachment` | 上传卡片（`api.putImageAsset`），图片仍走 image 块 | 280×76 |
| 日期/提醒 reminder | `reminder` | 双击原生 date input + 备注（P1 不做系统通知） | 240×64 |

### 1.1 content.data JSON 形状约定（供导出 agent 对齐）

> 外层仍为 `content = { format: 'tiptap-json', data }`（core `BlockContent.format` 固定，不改 core）。
> 真相字段全部在 `data`。

```jsonc
// table / code：data 是 Tiptap ProseMirror doc
{ "format": "tiptap-json",
  "data": { "type": "doc", "content": [
    { "type": "table", "content": [ {"type":"tableRow","content":[
        {"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"H"}]}]},
        {"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"C"}]}]}
    ]} ] } ] } }

// code：data 是 Tiptap doc，codeBlock.attrs.language
{ "format":"tiptap-json",
  "data": { "type":"doc", "content":[
    {"type":"codeBlock","attrs":{"language":"js"},"content":[{"type":"text","text":"const a=1"}]}
  ] } }

// equation
{ "format":"tiptap-json", "data": { "kind":"equation", "source":"E = mc^2" } }

// bookmark（隐私铁律：不抓网、不请求；只存用户输入）
{ "format":"tiptap-json", "data": { "kind":"bookmark",
    "url":"https://…", "title":"…", "description":"…" } }

// attachment（JSON 只存引用 id；Blob 存 OPFS）
{ "format":"tiptap-json", "data": { "kind":"attachment",
    "assetRef":"asset_xxx", "name":"x.pdf", "size":12345, "mime":"application/pdf" } }

// reminder（dueAt 为 epoch ms，0=未设置；P1 不做系统通知）
{ "format":"tiptap-json", "data": { "kind":"reminder", "dueAt":1735689600000, "note":"…" } }
```

- 静态渲染：table/code 用 Tiptap `generateHTML`（含 Table/CodeBlock 扩展）；代码块**额外**用 `highlight.js` 直接产 `hljs-*` token（Tiptap 装饰插件不在 SSR 跑）；公式用 KaTeX `renderToString`（SSR 字符串，不挂编辑器实例）。
- 导出：tiptap-static 由导出 agent 自维护；按上述形状出 HTML/PDF 即可。

### 1.2 依赖（授权清单内）
`@tiptap/extension-table(-row/-cell/-header)`、`@tiptap/extension-code-block-lowlight`、`lowlight`、`highlight.js`、`katex`、`@types/katex`。
- KaTeX 字体/样式**本地打包**：`import 'katex/dist/katex.min.css'`，Vite 把 60 个字体文件输出为相对 `/assets/`（grep 举证见验收）。**无 CDN**。

---

## 2. PWA 触屏手势（§4.6，PWA 先行）

- **手势状态机** `state/gesture.ts`：纯函数 `reduceGesture(state, event, cfg)`，Pointer 序列 → `tap / double-tap / longpress(500ms) / drag-start / drag-move / pinch-start / pinch-move`。阈值可配（`DEFAULT_GESTURE_CONFIG`：longpressMs=500、movePx=8、doubleTapMs=300、slop=24）。组件自持 500ms 定时器，到点派 `longpress-check`。
- **热区 ≥44px**：连接点 `.react-flow__handle` 在 `css/editor-theme.css` 放大到 44×44 透明点击区，`::after` 画 8px 视觉小点。
- **双指平移+捏合**：React Flow `zoomOnPinch`/`panOnDrag` 原生处理；`gesture.ts` 的 pinch 判定用于冲突兜底/未来离线增强。
- **粗指针工具按钮** `state/use-coarse-pointer.ts`（`matchMedia('(pointer: coarse)')`）：画布左上显式「选择/连线/平移」按钮组，**44×44** 触控热区，作为手势歧义兜底。
- **iOS**：`.react-flow__pane{touch-action:none}`、节点/handle `touch-action:manipulation`（配合 viewport maximum-scale）禁双击缩放/橡皮筋。
- 长按空白出菜单、双击编辑：双击编辑已在 BlockShell；长按连线的完整拦截（压住 handle 500ms 再拖才起连）接线留 Wave4/refine（状态机与热区已就绪）。

---

## 3. 边 P1（§4.3）

- **批量改色**：多选边后，色板对所有 selected 边批量 `setEdgeColor`（`ParentEdge` 用 `useStore` 读 selected edges）。
- **反转方向**：选中边浮层加「反转」按钮 → `api.reverseEdge(id)`（mock：交换 source/target + 句柄位互换）。
- **悬停高亮逻辑链**：`lib/graph-trace.ts` 纯遍历。悬停节点 = 无向连通集 `collectConnectedSet`；悬停边 = `collectEdgeChain`（两端连通并集）。命中集合内节点/边不透明，其余节点 `opacity:.2`、边 `opacity:.15`。

---

## 4. 聚焦分支与筛选视觉（消费 UI 态）

- **聚焦** `api.focusNodeId`：`collectFocusSet(edges, id)` = 自身 + 祖先链 + 后代子树；集合外节点降透明。取消（null）恢复。
- **标签筛选** `api.tagFilter = { mode:'any'|'all', tagIds:[] }`：`lib/filter-match.ts` 纯函数（空筛选=全命中；any=有交集；all=全包含）。非命中节点 `opacity:.2`。
- **增量整理**：`manualFixed`（ReadonlySet）节点在 `applyManualFixed` 中从 layoutPreview ghost 剔除——手动移动过的块整理预览不出现 ghost。store 接线 Wave4。
- 优先级：悬停链 > 聚焦 > 标签筛选（同时只生效一个）。

---

## 5. 深色模式配合（CSS 变量）

编辑器内硬编码色全部改为 shadcn 惯例变量 + 浅色 fallback（在 `css/editor-theme.css`）。**未改 index.css / tailwind.config**（面板 agent 负责深色值）。

本侧新增/引用、需面板 agent 提供值的变量：
```
--background / --card / --foreground / --border / --muted   （shadcn 已有，直接引用）
--editor-grid            点阵网格色（fallback #cbd5e1）
--editor-handle          连接点视觉小点色（fallback #94a3b8）
--edge-label-bg          边标签/浮层底色（fallback rgba(255,255,255,.9)）
--code-bg / --code-fg    代码块深底/字色（fallback #0b1020 / #e6edf3）
```
深色未合入前用 fallback 保证浅色正常。

---

## 6. 可选：布局 Web Worker

`workers/layout.worker.ts`（Vite `new Worker(new URL('./layout.worker.ts', {type:'module'}))`）：离线程跑 `core.layoutTree`。
- 消息协议：`postMessage({input: LayoutInput, mode: LayoutMode})` → `onmessage: LayoutResult`。
- **开关式助手**已就绪，不强制接线；Wave4 决定是否启用（大导图整理避免阻塞主线程）。

---

## 7. 测试（vitest）

- `state/gesture.test.ts`（8）：tap/double-tap/longpress/pinch/drag/cancel 序列。
- `lib/graph-trace.test.ts`（7）：连通集/聚焦集/边链/manualFixed。
- `lib/filter-match.test.ts`（5）：any/all/空筛选。
- `tiptap/static-p1.test.tsx`（9）：codeToHtml 含 hljs、表格 `<table>`、KaTeX 含 katex 无 CDN、stripDollars、斜杠菜单含 P1。
- `mock-editor-api.test.ts`（+4）：reverseEdge、setFocusNode/setTagFilter、putImageAsset、P1 默认尺寸。
- 全量 web：18 文件 / 107+ 用例绿；typecheck 绿；lint 0 error。

## 8. 真机截图（临时挂载，已还原）
- 目录 `/tmp/p1-i-shots/`：浅色下表格/代码/公式/书签/附件/日期各一块、粗指针工具按钮组（设备模拟）、悬停降透明。
- 临时挂载用 `App.tsx` 仅截图，截完**还原**（不在最终 diff）。

## 9. 遗留 / 交接
- 长按连接点的完整拦截（压住 handle 500ms 再拖才起连）：状态机+热区就绪，与 RF Connection 手势的精细冲突处理留 Wave4。
- EditorApi 新增字段/回调为**可选**：真实 store 适配（wiring/create-editor-api.ts）由存储 agent 实现后转必填。
- 公式/书签/附件/提醒的撤销栈合并、附件 OPFS 落盘（mock 仅返引用 id）待 Wave4。
- 代码块 live 语言切换与 Tiptap `codeBlock` 属性回写已通；表格行列菜单（加行/列/删/合并）依赖 Tiptap 自带能力，按钮 UI 留后续。
