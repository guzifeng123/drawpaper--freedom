# Wave21 · flow-layered 逻辑流分层有向图

第五种一键布局模式（P0 规划中唯一未交付的版式）：自上而下按「最长路径」分层，
父子边沿 y 轴向下展开，同层节点顶对齐成行，层内水平铺栏。

## 契约决策

- **core 契约（附加式，不升 schema 版本、不写迁移）**：`LayoutMode` zod 枚举附加
  `'flow-layered'`；解析宽容——未知/非法 mode 值一律 `.catch('mindmap-down')` 回退，
  任何脏值都不会导致文档打开失败（参照 Wave20 块嵌入「附加 kind 不升版本」思路）。
- **零新依赖**：未引入 dagre / d3-force / elkjs；`pnpm-lock.yaml` 零 diff。
  `packages/core/src/layout/layout.ts` 用纯 TS 手写最长路径分层算法。
- **边语义不变**：边仍只有父子一种；分层依据就是 parent 边 / parentId 主树，
  不引入关系类型概念。多父 / 成环弹窗与主父裁决仍在 graph/store 层，布局只消费裁决后的主树。
- **复用既有管线**：遵守同一 `LayoutInput / LayoutResult` 契约，pinned 绕行、
  仅整理选中分支、collapsed 收紧、250ms 缓动落位与可撤销宏、增量整理
  （`layoutTreeIncremental`）全部自动生效，未新写动画 / 历史机制。

## 算法（确定性，`layoutFlowLayeredInto`）

1. **主树裁决**：同一 target 的多条入边「首条 wins」（与 `buildNestedTree` 同规则），
   得 `parentOf`；反查 `childrenOf` 即主树。
2. **根**：集合内无 parentOf 的节点；`rootId` 指定时单根；成环（无根）时按字典序
   强取最小节点为根，环边沿主树截断。
3. **最长路径分层**：`rank(root) = 0`；否则 `rank(node) = rank(parent) + 1`。
   memo 递归 + 递归栈守卫：环上节点命中栈守卫按 rank 0 退化——不死循环、
   主树上 `rank(child) = rank(parent) + 1` 恒成立（不逆层）。
4. **行高**：每层取该层最大实测高；行顶 y 逐行累计，行距 = `rankSpacing`，
   同层顶对齐（与 org-tree 行高策略一致，但行距走 rank 轴配置）。
5. **层内排序**：rank 0 = 根按字典序；其后每层按「父节点在上一层的栏位顺序」排序、
   同父兄弟按 id 字典序——父群不交叉打散。层内从左到右按实测宽 + `nodeSpacing`
   顺序铺栏，同层必然不重叠。
6. **多根森林**：各根独立分层、rank 0 同行，从左到右排开，根间留同级间距
   （实测宽 + nodeSpacing），各自子树在下方独立展开。
7. **固定锚点**：pinned / manualFixed 参与层级计算但坐标不写入，由既有绕行管线
   沿横向（x）避让。

## 近似与局限（JSDoc 已声明）

- 层内不做交叉最小化迭代（barycenter 平移），只保证不重叠与父序稳定。
- 未裁决的多父输入按首条入边 wins 退化（与其它布局模式一致）；层内不做
  反向边检测，被截断的环边可能出现一条向上的回边（纯函数防护已保证不死循环）。
- `tighten` 在本模式下恒为「按实测宽紧凑铺栏」，仅在 notes 标注。

## 验收

- core 单测（`packages/core/src/layout/layout.test.ts` 新增 describe）：
  单树 rank 单调 / 同层顶对齐、单链 DAG、多根森林各成层且根间不重叠、
  交错实测宽下同层零残留碰撞、环输入不死循环不逆层、
  collapsed / pinned / 选中分支 / tighten / incremental 组合。
- schema 宽容解析测试（`schema.test.ts`）：合法 `flow-layered` 原样承载；
  未知 mode 回退 `mindmap-down`。
- web e2e：`e2e/wave21-flow-layered.spec.ts`（一键整理后断言层级坐标关系、
  多根画布可用、动画后可撤销还原）。
