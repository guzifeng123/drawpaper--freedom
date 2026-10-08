# Wave22 · flow-layered 层内 barycenter 交叉最小化

Wave21 的 `flow-layered` 只做「最长路径分层 + 贪心父序铺栏」，层内不做交叉优化，
多父 DAG 的父子边视觉交叉偏多（Wave21 文档自列的近似与局限之一）。
本路在**纯 core 算法**内补一层有界 barycenter 启发式迭代，把层内父子边交叉压下去；
web 侧零改动，坐标自动受益。

## 契约红线（与 Wave21 一致，本路未动）

- 不升 schema 版本、不写迁移、不改 `LayoutMode` 枚举；`LayoutInput / LayoutResult`
  管线签名不变。
- 零新依赖：未引入 dagre / d3-force / elkjs；`pnpm-lock.yaml` 零 diff。
  `packages/core/src/layout/layout.ts` 纯 TS 手写。
- core 零 DOM / React；边仍只有父子一种语义，边色常量不动。
- pinned 绕行、仅整理选中分支、collapsed 收紧、250ms 动画与可撤销宏、增量整理
  全部继续复用既有管线。

## 算法（`layoutFlowLayeredInto` 第 7 步，确定性）

分层（rank）确定之后、最终坐标写入之前，插入 barycenter 迭代：

1. **邻居口径**：只取恰好跨越相邻两层的边（`rank(target) = rank(source) + 1`），
   且限定「同一主树根块」内。跨越多层或向上的回边不参与（与环防护口径一致）。
2. **初始层序** = Wave21 既有贪心父序（rank0 根字典序；其后按主父在上一层的栏位序、
   同父按 id）。这一步对纯树已是交叉最优（零交叉），故迭代对纯树是不动点。
3. **交替扫**：向下扫（rank 1→max）每层按「上层父邻居列重心」排序；
   向上扫（max→0）每层按「下层子邻居列重心」排序。
   - 重心 = 邻居列坐标的算术平均（barycenter，非 median）；
   - 无该方向邻居的节点重心 = 当前列（原位不动）；
   - 并列按 id 字典序（`localeCompare`）→ 同输入同输出。
4. **接受准则**：每扫一轮，用 `countLayerCrossings` 计算相邻层父子边交叉总数；
   仅当**严格下降**才接受该轮并继续，否则立即停。单调改善、任一轮无改善即停。
5. **轮次上界**：向下/向上交替，总扫次 ≤ `2 × FLOW_MAX_SWEEPS`，`FLOW_MAX_SWEEPS = 24`
   （即 ≤48 扫）。配合「无改善即停」，必然终止、绝不震荡死循环。
6. **铺栏**：用精炼后的层序从左到右按实测宽 + `nodeSpacing` 铺栏，同层天然不重叠、
   顶对齐成行。

### 导出的纯函数 `countLayerCrossings`

```ts
countLayerCrossings(
  order: ReadonlyMap<number, readonly string[]>,
  edges: ReadonlyArray<{ source: string; target: string }>,
  rankOf: ReadonlyMap<string, number>,
): number
```

交叉定义：同一相邻层对 `(r, r+1)` 的两条边 `(u1,v1)`、`(u2,v2)`，
若上层列 `u1<u2` 但下层列 `v1>v2`（两端都不同），计一次交叉。
共享端点（同父/同子）不计数；非相邻层边不计数。迭代与单测共用同一口径。

## 硬不变量（全部写进单测）

- **rank 不变**：只在层内重排，子不与父同层 / 逆层（主树 `rank(child)=rank(parent)+1` 恒成立）。
- **同层 AABB 零重叠、顶对齐成行、栏间距 ≥ `nodeSpacing`**：铺栏逻辑不变，重排不改变逐栏推进。
- **多根森林**：不同根在 rank0 横排；重排只在「同层 + 同主树根块」内发生，
  块顺序恒等于 rank0 根字典序，不同根子树不得交错重排（跨根多父边也不拉跨块）。
- **成环退化**：rank 计算的 memo + 递归栈守卫不变，不被迭代重新引入环或死循环。
- **确定性**：id 字典序 tie-break，两次 `layoutTree` 输出逐字节一致。

## 局限（为何不引 dagre）

- **贪心启发式，不保证全局最优**：barycenter 只做单调局部改善，可能停在局部最小；
  对真实导图（数十节点、多父边有限）交叉数显著下降，但不追求最小交叉精确求解
  （那是 NP-hard，dagre 自身也只是 Sugiyama 启发式）。
- **零依赖契约**：引入 dagre/elkjs 会带新的 bundle 与维护面，违背 Wave21 已定的
  「纯 TS 手写、pnpm-lock 零 diff」决策；本路保持该决策。
- **非相邻层边不计数**：长跨边 / 回边的视觉交叉不纳入优化目标（它们在正交分层里本就
  走折线，且回边是已知退化情形）。

## 实测

- 单测 `layout.test.ts` 新增 8 例：构造多父 DAG（贪心父序层2=[D,E,G]，相邻层交叉=4），
  barycenter 后层2=[E,D,G]，交叉 **4 → 2** 严格下降；单链/单树/多根森林交叉恒为 0
  且层序与改造前一致（防误伤）；K2,2 诱导震荡输入有界终止、不反弹；环/pinned/collapsed 组合不回退。
- core 单测：基线 350 → 358（+8）。
- web e2e `wave21-flow-layered`（纯树夹具）自动受益、无需改断言。
