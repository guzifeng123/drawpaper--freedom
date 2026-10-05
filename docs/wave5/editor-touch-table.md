# Wave5b · 触屏长按连线 / 表格合并拆分 / 附件 OPFS e2e 收口

> 范围：编辑器 `packages/web/src/editor/`（新增 `nodes/ConnectHandle.tsx`、表格工具条扩展、`tiptap/table-ops.test.tsx`）、`wiring/dev-hooks.ts`（DEV-only 检视钩子）、`e2e/fix-editor.spec.ts`。
> 分支：`fix/editor-touch-table`（基于 develop 6b50c3b）。

---

## 1. 触屏长按 Handle 起连线（§4.6 再攻关）

### 根因
Wave3-I 只把手势状态机（`state/gesture.ts`）与粗指针显式「连线」按钮做了，**触摸下按住连接点 500ms 进入连线态未接通**——原因是 RF v12 的 `<Handle>` 用 pointerdown 即起连，与 pane 触控平移/缩放手势冲突，且无公开 API 编程起连（`useReactFlow()` 不暴露 `connectionStartHandle`）。

### 解法（不依赖 RF 内部 store，稳定）
新增 `nodes/ConnectHandle.tsx`：
- **鼠标**：原样渲染 RF `<Handle>`，行为零变化。
- **触摸**：`onPointerDownCapture` 拦截 `pointerType==='touch'` 且为 `source` 点，`preventDefault+stopPropagation` 阻止 RF/pane 抢手势；起 500ms 定时器。
  - 500ms 内移动 >8px → 取消（退化为平移/拖块）。
  - 到点：`navigator.vibrate(15)` 触觉反馈 → 进入「连线中」，画一根 `position:fixed` 的蓝色虚线（handle 中心 → 手指）。
  - 手指移动：更新虚线终点。
  - 松手：`document.elementFromPoint` 命中 `.react-flow__node[data-id]` → `api.addEdge(source, targetId)`；命中空白 → 在 screenToFlowPosition 建新文本块并连父子（与既有 `onConnectEnd` 一致）。自环/重复校验由 store addEdge 处理。
- 热区 ≥44px 沿用 `editor-theme.css`。
- **粗指针「连线/选择/平移」工具按钮组保留**为正式兜底（不删除）。

### 时序下沉
500ms/8px 阈值、长按/拖拽判定全部在 `gesture.ts` 纯函数单测覆盖；e2e 只走主路径。

---

## 2. 表格合并/拆分单元格（验收缺口）

### 配置
`Table.configure({ resizable:false, allowTableNodeSelection:true })`（live + 静态两处），支持 ProseMirror CellSelection 拖选多格。

### 工具条
`nodes/table-toolbar.tsx` 在既有「加行/列、删行/列、表头」后补：
- **合并**（`mergeCells()`）：仅当 CellSelection 跨多格时可用（`editor.can().mergeCells()`）；否则 disabled 并 title 提示「拖选多个单元格后可合并」。
- **拆分**（`splitCell()`）：仅当光标位于合并格（colSpan/rowSpan>1）时可用。
- 用 `useEditorState` 订阅事务实时刷新禁用态。
- **关键坑**：合并/拆分链上不能先 `.focus()`——`.focus()` 会把 CellSelection 折叠成普通光标，导致命令失效。按钮走 `editor.chain().mergeCells().run()`（不 focus）。

### 测试
- 命令层单测 `tiptap/table-ops.test.tsx`（3 用例）：普通光标 mergeCells 不可用；CellSelection 跨两格可用；mergeCells 后 HTML 出现 `colspan="2"`，splitCell 还原。
- e2e 只断言按钮存在与禁用态（headless 下 ProseMirror 单元格拖选无法稳定自动化，已在文档注明）。

---

## 3. 附件 OPFS 真实上传 e2e

### 现状核对
- 管线已在：core `store.putImageAsset` → `storage.putAsset`（OPFS `putAsset`）→ 登记 `doc.assetRefs`；OPFS 不可用时 `storage.putAsset` 抛错 → store 返回空 assetRef。
- p1-blocks AttachmentBlock 经 `api.putImageAsset(file)` 上传并回写 `{assetRef,name,size,mime}`。

### DEV 检视钩子（wiring/dev-hooks.ts，DEV-only，不进生产 dist）
- `opfsAvailable(): boolean`
- `listAssetRefs(): string[]`
- `opfsHasAsset(ref): Promise<boolean>`（经 `getAsset` 读 OPFS blob）

### e2e（e2e/fix-editor.spec.ts）
1. 造附件块 → filechooser `setFiles` 上传真实临时 txt。
2. 断言卡片显示文件名。
3. OPFS 可用（headless chromium + localhost 安全上下文下 `navigator.storage.getDirectory` 可用）：assetRefs 登记且 OPFS 中确有该 blob。
4. reload 后附件卡片仍在（Dexie 持久化）。

---

## 4. 测试 / 验收数字
- 单测：core **129**（持平）、web **176**（173 → +3 table-ops）。
- e2e：**30 条**全绿（27 基线 + 新增 3：附件 OPFS、触屏长按连线、表格按钮）。
- typecheck 0 error；lint 0 error；`pnpm --filter @drawpaper/web build` 通过（PWA precache 正常）。
- 性能 e2e 无回归：500 块 60fps、2000 块 TTI 6.6s（Wave5a 优化未回退）。

## 5. 截图（/tmp/fix-editor/）
- `attachment-card.png`：附件卡片显示「方案-v2.pdf / 13 B」+ 删除按钮。
- `table-toolbar.png`：表格编辑态工具条（加行/列/删/表头 + 合并/拆分）。
- `touch-connect-state.png`：触屏长按后蓝色虚线跟随线（连线中态）。

## 6. 遗留 / 说明
- 长按起连目前仅对 **source** 点（右/下）生效，用于拖出子块；target 点（左/上）长按入连留后续。
- 表格单元格**拖选**本身依赖 ProseMirror 原生鼠标拖选（headless e2e 未自动化）；命令层已单测覆盖。
- 附件 dataURL 降级路径（OPFS 完全不可用）在 headless 下走不到（localhost 安全上下文 OPFS 可用），留真机/非安全上下文人工验证。
- 粗指针显式「连线」工具按钮组作为正式触屏兜底保留（README「触屏」小节已注明）。
