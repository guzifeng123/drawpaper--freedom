# Wave22 · 撤销栈有界上限（undo-history-cap）

给 core 的命令撤销栈（`createCommandStack`）加一个有界历史上限，消除长会话 /
超大文档下 undoStack 随编辑单调增长导致的内存膨胀。纯 core 内部改动，附加式新增，
不升 schema 版本、不写迁移、不动持久化格式。

## 问题

`packages/core/src/store/command.ts` 原先的 undoStack（`TimedCommand[]`）只做
coalesce（800ms 窗同 key 合并），**没有任何长度上限**。每条命令是一个闭包，持有
`execute / undo` 与节点坐标、边等引用；一键整理宏（`executeMacro`）虽整体算 1 条，
但宏内仍捕获 N 个节点的旧坐标。后果：

- 长会话反复编辑，栈只增不减；
- 10k 块级超大文档上，每条命令闭包的引用基数很大，内存单调上涨且不回落。

## 契约决策（附加式）

- **新增可选项 `maxHistory?: number`，缺省 = `DEFAULT_MAX_HISTORY = 200`**。
  常量集中在 `command.ts` 顶部并导出。旧调用方（`store.ts` 三处实例化点）不传参，
  即自动获得默认上限行为，无需改动。
- **语义**：`push` / `executeMacro` 推入一条新命令后，若 `undoStack.length > 上限`，
  `shift()` 丢弃最旧的一条（`while` 兜底恒保证长度 ≤ 上限）。被丢弃的最旧命令
  不再可撤销——`canUndo` 退到栈顶即 `false`。
- **`maxHistory <= 0` 视为不限制（无硬顶）**，作为逃生口留给特殊调用 / 测试，
  单测已锁定该语义。
- **不碰持久化**：这是 CommandStack 运行时行为契约的小改动，不是存储格式变更；
  不升 schema 版本、不写迁移、不加 schema 版本字段。

## 为什么丢弃最旧命令是安全的（内存模型）

栈中命令是「从某一基线文档出发」依次执行的变换：`C1, C2, …, Cn`，
`current` 恒等于执行完 Cn 后的文档。`undo()` 逆序弹出，每次 `current = Ck.undo(current)`，
要求 `current` 恰好是「执行完 Ck 后」的文档。

丢弃最旧命令 C1（shift）后，剩余 `C2..Cn` 仍是一条闭合的逆序链：

- 丢 C1 **不需要**改写 C2 的 undo——因为 C2.undo(执行完 C2 的文档) 本来就得到
  「执行完 C1 后的文档」，这正是裁剪后的新基线；
- 用户一路 undo 到底，停在「执行完最旧存活命令」之后的状态（而不是损坏文档）；
- redo 链只含被 undo 掉的命令，全部落在存活段内，完整可用。

因此**不需要快照重写 / 二分基线重建**这类复杂方案，单次 `shift` 即自洽。

### coalesce 与宏如何计入上限

- **coalesce 合并**：窗内同 key 命令原地替换栈顶，不新增条数，自然不额外占上限；
  它之后再推新命令触发的裁剪，与 coalesce 叠加正确（合并条作为一个整体被裁 / 被留）。
- **executeMacro**：多命令打包为**一个**撤销单元，整体只占 1 条上限名额。
- **新 push 清空 redoStack** 的既有行为不变；裁剪只作用于 undoStack。

## 对用户撤销深度的影响

- 默认最多可连续撤销约 **200 个独立撤销点**（连续输入 / 拖拽已被 coalesce 合并，
  一键整理宏只算 1 点）。正常人工编辑会话的独立手势远小于此，用户无感知。
- 超长会话编辑超过 200 个独立撤销点后，最早的历史会被静默丢弃——
  用户无法再撤销到「超过 200 步之前」的状态，但此后每一步都仍可正常 undo / redo，
  文档内容始终正确，不会损坏或错乱。
- 取值理由：200 覆盖一次正常人工会话的撤销深度，同时给超大文档上每条闭包的
  引用基数设硬顶，把内存从「随会话无限增长」压成「有界」。

## 测试锁定（`command.test.ts`）

新增一组 `undo history cap (maxHistory)` 用例：

1. 连推 250 条 → 栈长 = 200、`canUndo` 为真；
2. 连 undo 200 次 → 文档等于「执行完前 50 条」的文档，再 undo 返回 `undefined` / `canUndo=false`；
3. redo 链在未裁剪段完整可用；
4. coalesce 窗内连推不增长，超限裁剪与 coalesce 叠加正确；
5. `executeMacro` 作为 1 条计入上限；
6. 自定义 `maxHistory=5` 立即生效；
7. 裁剪后中途 undo + 新 push，剩余 undo/redo 链自洽无错乱；
8. `maxHistory <= 0` 关闭上限（不限制）——锁定语义。

## 门禁

- `pnpm install --frozen-lockfile` → `pnpm -r build` → `pnpm typecheck` → `pnpm lint` →
  `CI=true pnpm -r test` 全绿；core 单测 350 → 358（+8），web 单测 363 不变、零回退。
- `store.test.ts` / `wave3.store.test.ts` 既有 undo 断言均为个位数，无「无限栈深度」
  假设，无需调整；已逐条核对。
