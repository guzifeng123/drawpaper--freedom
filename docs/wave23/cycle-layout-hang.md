# Wave23.5 P1 修复：含环边导致主线程同步死锁、「连线冲突」弹窗不可达

> 分支 `fix/cycle-layout-hang`，基线 rc.14 = `4836b69`。P1。

## 现象

干净基线上，文档里已有父子边 `A→B` 时，再从 `B` 连到 `A`（或 `A→C` 后 `C→A`）：

- 页面**主线程同步死锁**，无 `pageerror`、无异常栈；
- 「连线冲突，请裁决」弹窗**永远挂不出来**（不可达）；
- 指针拖拽、触屏长按两条连线路径都会触发；
- 多父无环（`A→C`、`B→C`）弹窗正常、页面响应正常——唯独**成环**卡死。

dev（`vite dev`）与 `vite build` + `preview` 生产 bundle 双形态均可复现。

## 根因定位

### 调用链

```
用户松手 addEdge(B, A)
  → core store.addEdge            packages/core/src/store/store.ts:1140
      runCommand 先把边写进 doc（此时 doc 已含环 A→B、B→A）
      promptConflicts(depthBefore) store.ts:736
        analyze(...) = detectConflicts（有界，1ms 返回 cycles=1）
        set(d.pendingConflicts = pending)
        deps.resolveConflictUi(pending)  ← 返回挂起 Promise，等用户裁决
  → set 触发 React 订阅者重渲染
      App overlayResult useMemo   packages/web/src/App.tsx:206
        computePanelsPaginate(panelsApi)   packages/web/src/export/useExportModel.ts:33
          paginateFit({nodes, edges, collapsed, ...})
            activeNodeSet(...)             packages/core/src/paginate/paginate.ts:159
              isFoldedDescendant(id)       packages/core/src/paginate/paginate.ts:180  ← ★死循环
```

关键时序：`runCommand` 先落边、`promptConflicts` 后弹弹窗。**弹窗等待裁决期间，含环 doc 已经交给 React 渲染**，死锁就发生在这次渲染的 useMemo 里，弹窗自然永远出不来。

### 死循环函数（文件:行号 + 为何无界）

`packages/core/src/paginate/paginate.ts`：

1. `buildParentOf`（原 145-153）：按「首条入边 wins」把 `edges` 折成 `parentOf` 映射，**不像 `graph/buildMainTree` 那样用 `reachesUpward` 跳过闭合环的边**。对环 `A→B`、`B→A`：
   - 边 `A→B`：`parentOf[B] = A`
   - 边 `B→A`：`parentOf[A] = B`
   - 结果 `parentOf = {B:A, A:B}` —— **自成交的 2-环**。
2. `isFoldedDescendant`（原 180-187）：`while (cur) { if (collapsed[cur]) return true; cur = parentOf.get(cur); }` 沿 parent 指针上行，**无 visited 守卫**。在 `{B:A, A:B}` 上 `cur` 在 `B↔A` 之间无限交替，永远不为 `undefined`，也永远命中不到 `collapsed`（即便没有任何折叠块）——**纯函数级无限循环**。

为何多父无环不挂：`A→C、B→C` 时 `parentOf={C:A}`（首边 wins），上行 `C→A→undefined` 必然终止。唯有 `parentOf` 成环时上行才不收敛。

### 为何「core 有界而 web 死锁」

统筹早期 vitest 已证明：`createEditorStore` 里直接 `addEdge` 成环，**1ms 返回** `cycles=1`、边已应用、`pendingConflicts` 就位。即 `store.ts` 同步路径（`runCommand`/`detectConflicts`）有界。

死锁不在 store，而在 **React 提交后被同步触发的 web 派生**：`App.tsx:206` 的分页虚线叠加层在**每次 doc 变化**（`blankInitialDoc.page.showPageBreak=true` 默认开）都同步重算 `computePanelsPaginate → paginateFit → activeNodeSet.isFoldedDescendant`。该分页函数在 core 里，但此前**没人拿含环 edges 喂过它**——core 单测只覆盖了 DAG/无环输入，于是这条 web 渲染链路上的无界遍历漏网。

### 取证（core 最小复现，OS 看门狗）

临时用例 `paginateFit({nodes:[A,B], edges:[A→B,B→A], ...})`：

```
$ timeout 12 vitest run repro-cycle.test.ts
REAL_EXIT=124     # OS timeout 强杀 → paginateFit 永不返回（无限循环实锤）
```

修后同一用例：

```
paginateFit   cyclic returned in 1 ms, pages=1
paginateTiles cyclic returned in 0 ms, pages=1
paginateFlow  cyclic returned in 1 ms, pages=1
```

## 修法（双层，不只堵 UI）

### web 渲染层（消除死锁源头）

死锁发生在 web 渲染链路 `App overlayResult useMemo → computePanelsPaginate → paginateFit → isFoldedDescendant`。修掉该无界遍历后（见下 core 改动，分页是 core 纯函数），含环 doc 在 `pendingConflicts` 等待期间的渲染在 ~1ms 内完成，弹窗可达、页面始终响应。指针拖拽、触屏长按（及未来键盘）三条连线路径同源受益——它们最终都汇入同一个 `addEdge → runCommand → 渲染` 链路。

> 不做的事：不「弹窗出现前跳过渲染」、不 hide 叠加层、不放宽超时凑绿。分页叠加层仍在每次 doc 变化时同步计算，只是现在它对含环输入有界。

### core 层兜底（含环/多父输入必须有界退化）

文件 `packages/core/src/paginate/paginate.ts`：

1. **`buildParentOf` 环安全**：新增 `reachesUpward(start, target, parentOf)`（带 visited），构建 parentOf 时若某条边会在 parent 指针上闭合环（`target` 已是 `source` 的祖先）则**跳过该边**——与 `graph/buildMainTree` 同策略。保证 `parentOf` 恒为森林（无环）。多父「首条入边 wins」语义不变；DAG 输入行为零变化，仅含环输入从「死锁」变为「有界退化」。
2. **`isFoldedDescendant` visited 守卫**：上行循环加 `seen` 双保险——即使未来任何路径再喂入含环 parentOf，上行也必然有界返回，绝不主线程死锁。

同时审计并复核了 core 其余「从 edges 构造树/遍历」的纯函数，均已具备环防护（无需改动，仅补测试证明）：

- `graph/buildMainTree`：`reachesUpward` 跳闭合环、BFS `visited`；
- `graph/enumerateSubtree`：队列遍历带 `seen`；
- `graph/getAncestorChain` / `getFocusViewSet`：带 visited；
- `layout/buildNestedTree`：递归建树带 `visited`（强制根），喂 d3-hierarchy 的恒为无环树；
- `layout/layoutFlowLayeredInto`：DFS `inStack` 环检测；
- `paginateFlow`：childrenMap DFS 带 `seen`。

### core 单测增量（`packages/core/src/**`）

直接喂含环 edges（`A→B、B→A`）与多父 edges（`A→C、B→C`），断言有界返回（不抛/不挂）且输出确定：

- `graph/graph.test.ts`：`buildMainTree` 成环产出无环森林、`enumerateSubtree`/`getFocusViewSet`/`getAncestorChain`/`detectConflicts` 有界且确定；多父首边 wins。
- `layout/layout.test.ts`：`layoutTree` 全 5 种 mode（mindmap-right/down、org-tree、radial、flow-layered）+ `layoutTreeIncremental`，含环与多父输入均有界、两次结果 deep-equal、节点全部落点。
- `paginate/paginate.test.ts`：`paginateFit/Tiles/Flow` 含环（含折叠）与多父输入均有界返回、两次结果 deep-equal。

core 单测基线 366 → 385（+19）。

### e2e 真断言（`packages/web/e2e/wave23-cycle-conflict.spec.ts`）

- **指针/连接路径**：建 A、B，先 `A→B`，再经 onConnect 同一个 `api.addEdge(B,A)` 成环 → 断言「连线冲突，请裁决」弹窗在 5s 内出现、页面可交互；
  ①点「取消」→ 触发边 `B→A` 精确回退（edges 恢复 1 条）、弹窗关闭、再次成环弹窗仍可达；
  ②重触发后勾选「断开边」复选框 +「确定」→ applyResolution 后图恢复无环（edges=1）、`undo` 回到 2 条、`redo` 再回 1 条（撤销/重放语义正确）。
- **触屏路径**：`PointerEvent pointerType=touch` 长按 B 的 source handle 拖到 A（范式同 `fix-editor.spec.ts`）→ 断言弹窗有界出现 +「取消」后边数回退到 1。
- 断言均为真断言（弹窗 DOM 文案、边数 `getState().doc.edges.length`、按钮可点）。无 `test.fixme`/`skip`，无放宽超时。
- 纯键盘成环弹窗断言属 Wave23 H 分支（`feat/keyboard-cross-connect`，本基线不含其代码），不在此 spec 写键盘选择器。

## 防护不变量（防回归）

1. **任何从原始 `edges` 构造 parent/child 树再上行/递归的路径，必须先经 `buildMainTree` 式环化或自带 visited 守卫**——`buildParentOf` 现已环安全，`isFoldedDescendant` 双保险。
2. **core 不依赖调用方「永远先裁决」**：即便 doc 短暂处于含环状态（`pendingConflicts` 等待期间），所有布局/分页/图纯函数也必须有界返回，不得死锁。
3. web 渲染链路（同步 useMemo/effect）里凡现算父子/后代/祖先/子树处，须有 visited 或代数上界（既有 `graph-trace.ts`、`hiddenAfterCollapse`、`focus-nav`、Outline 均已守）。
