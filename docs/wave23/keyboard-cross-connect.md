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

## 已知边界（非本路引入）

- 候选过滤会排除「已连接的子块」（它是源的后代），因此从源块再选一次直连子块不会出现——重复边在键盘入口是**结构性不可达**（不会产生第二条边）；显式「该父子关系已存在」toast 仍是 `onConnect` 的共享安全网（指针拖拽路径可达）。
- 成环目标（从子块选父块）**会**出现在候选中（父不是子的后代），确认后递交到共享 `addEdge` 校验链触发既有裁决弹窗；在当前基线渲染器上，真正把成环边渲染出来会触发一个**预存在的渲染器卡死**（已在干净基线上复现，非本路改动引入），故 e2e 仅验证「成环目标被正确递交到候选」，不断言弹窗 DOM。
