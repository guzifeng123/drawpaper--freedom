# Wave23 H 路：纯键盘跨块父子连线

在已有的指针拖拽连线（`c` 进入 connect 模式 → 拖目标手柄松手）之上，补一条**纯键盘**完成跨块父子连线的完整链路。全程不碰鼠标：焦点在某块上按 `c`，弹出当前文档内目标块选择器，键入过滤、↑↓ 选择、Enter/Tab 确认、Esc 取消。

## 键位与流程

1. 焦点落在某块上（既有方向键 / Tab 焦点体系），裸键 `c` → `api.setMode('connect')`。
   - 源块 = 当前选中/焦点块；焦点环清晰可见。
   - aria-live 播报「连线模式：选择目标块，Esc 取消」。
2. 进入后：
   - **直接键入文字** → 弹出目标块选择器（`role="listbox"`）。输入框自动聚焦。
   - **↑ / ↓** 在候选间移动高亮（`aria-activedescendant`）。
   - **Enter / Tab** 在高亮目标上确认。
   - **Esc** 取消连线。
   - **点击外部遮罩** 关闭选择器（等同取消）。
   - **IME 组合期让路**：`e.isComposing` 时不响应方向键/Enter/Esc，等中文上屏。
3. 确认 → 走 `CanvasEditor.onConnect` **完全相同**的校验与 `api.addEdge` 路径：
   - 自环 toast 拦截；
   - 重复边选中提示；
   - 否则 `api.addEdge(source, target, { sourceHandle:'right', targetHandle:'left' })`。
   - 多父 / 成环由 core `analyze` 检出 → `pendingConflicts` → 既有「连线冲突，请裁决」弹窗；撤销栈自动继承（connect 是 `'connect'` 命令）。
4. Esc 退出连线模式回 `select`，**不产生任何边变更**（aria-live 播报「已取消连线」）。

## 与指针路径共用校验（不另造校验）

键盘确认把 `{sourceId, targetId}` 原样喂回 `CanvasEditor.onConnect`，与指针拖松手走同一段：
- `onConnect` 的自环 / 重复边 toast 拦截；
- `api.addEdge` 的自环禁止、重复边短路、多父 / 成环挂起冲突；
- core `analyze` → `PendingConflicts` → `ConflictDialog` 裁决；
- 撤销 / 重做。

core 侧本路**零新增逻辑**：`addEdge` 命令已有的纯校验（自环、重复边短路）与 `detectConflicts`（多父 / 成环）被原样复用，不新增 relation / 线型。

## 候选过滤纯函数

`packages/web/src/editor/lib/connect-targets.ts`（零 DOM、可单测）：

- `collectDescendantIds(edges, sourceId)`：沿父子边向下 BFS（带 visited 防环），收集源块全部后代。
- `listConnectCandidates(doc, sourceId)`：返回 `{ candidates, excluded }`。
  - **排除源块自身**（self）与其全部后代（descendant），并给出排除理由——这是「成环不可达」的结构性保证。
  - 排序稳定：标题前缀命中 > 标题包含 > 正文包含；同 tier 按 `nodeId` `localeCompare` 兜底 tie-break。空查询返回全部候选（按 `doc.nodes` 顺序）。
- 正文取自 core 导出的 `extractNodePlainText`。

## 空态决策

- 无匹配候选时列表显示空态「无匹配块」（可读）。
- **Enter 在空态无副作用**：不新建子块。本路不实现「Enter 新建并连接子块」——该语义属于 `onConnectEnd` 指针松手空白建子块路径（addNode+addEdge，可撤销），键盘选择器保持纯「选已有目标」语义，避免两套建子块入口漂移。

## 可访问性

- 选择器容器 `role="listbox"`（aria-label「可连接的目标块」），每项 `role="option"`，高亮项 `aria-activedescendant`。
- 源块与目标选项焦点环可见（editor-theme.css）。
- aria-live（复用既有 Toaster / 状态播报）：进入连线模式、候选数、成功连接 A→B、失败原因、已取消。
- axe-core 对该链路无新增 violation（沿用 wave9/wave11 既有 e2e）。

## 挂账（成环冲突弹窗 e2e 阻塞）—— Wave23.5 已修复

> **状态：已由 `fix/cycle-layout-hang`（Wave23.5）修复。** 根因与修法见
> [`cycle-layout-hang.md`](./cycle-layout-hang.md)。本路最初记录的 e2e 阻塞不再成立，
> 成环 `ConflictDialog` 现已可达并被 e2e 覆盖；下方取证摘要仅作历史存档保留。

- **复现环境（历史）**：dev（vite dev）与生产构建（`vite build` 产物 + `vite preview`，minified、无 StrictMode
  dev 双调用）**均复现**——A→B 存在时 `addEdge(B,A)`（或 A→C 后 `addEdge(C,A)`）**同步卡死主线程**，
  evaluate 8s 不返回、随后页面无响应、无 pageerror、`ConflictDialog` 不可达。干净基线
  `4836b69` 同样复现，与本路改动无关（已由统筹独立取证确认）。
- **对照（历史）**：多父场景（A→C 与 B→C，无环）弹窗**正常出现、页面保持响应**——缺陷精确限定为
  「成环形状的图」，不是冲突裁决链路本身的问题。
- **根因（Wave23.5 定位）**：布局链路（d3-hierarchy / 布局遍历）在含环图上无限循环；core 的
  冲突裁决设计本应在 `resolveConflicts` 前不应用成环边，但 web 侧在 `pendingConflicts` 等待期间就
  渲染了含环文档。修复方向（布局环防护，或冲突裁决前不应用边）已在 Wave23.5 落地。
- **覆盖现状**：core 单测（`store.test.ts` 成环裁决，注入 analyzer）覆盖裁决逻辑；成环
  `ConflictDialog` e2e 阻塞已随修复解除。

## 已知边界

- 候选过滤会排除「已连接的子块」（它是源的后代），因此从源块再选一次直连子块不会出现——重复边在键盘入口是**结构性不可达**（不会产生第二条边）；显式「该父子关系已存在」toast 仍是 `onConnect` 的共享安全网（指针拖拽路径可达）。
- 成环目标（从子块选父块）**会**出现在候选中（父不是子的后代），确认后递交到共享 `addEdge` 校验链；
  触发成环冲突弹窗的 e2e 此前因基线渲染器成环死锁而 `test.fixme` 挂账，**Wave23.5 修复后已解除**（见上一节）。
