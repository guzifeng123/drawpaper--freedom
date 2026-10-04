# Wave3-F · layout 放射/增量/收紧 + graph 聚焦链 交付说明

> 所有者：Wave3-F（core 纯逻辑：放射树布局、增量整理、折叠收紧、聚焦/逻辑链图分析）。
> 全部零 DOM 纯函数、确定性输出、Vitest 覆盖。未新增依赖（d3-hierarchy 为 core 既有依赖）。
> 所有权范围：`packages/core/src/layout/`、`packages/core/src/graph/`（含新增文件/测试）；
> 不改 core 根 barrel、model/paginate/store/web、配置与 ARCHITECTURE。

## 1. 新增 / 变更签名

### 1.1 `layout/`（`packages/core/src/layout/layout.ts`）

```ts
// LayoutInput 新增两个可选字段（既有字段语义不变）：
export interface LayoutInput {
  nodes: BlockNode[];
  edges: Edge[];
  rootId?: string;
  rankSpacing: number;
  nodeSpacing: number;
  measured: Record<string, MeasuredSize>;
  pinned?: ReadonlySet<string>;
  collapsed?: Readonly<Record<string, boolean>>;
  // —— 新增 ——
  /** 手动微调过的节点：与 pinned 同避让处理，语义独立（notes 分列）。 */
  manualFixed?: ReadonlySet<string>;
  /** true=折叠/删除后按实测宽紧凑排布，兄弟分支向心收拢。 */
  tighten?: boolean;
}

// layoutTree：mode 现在接受 'radial'（不再抛错）。
export function layoutTree(input: LayoutInput, mode: LayoutMode): LayoutResult;
// mode ∈ 'mindmap-right' | 'mindmap-down' | 'org-tree' | 'radial'

// —— 新增：增量整理 ——
export interface IncrementalLayoutInput extends LayoutInput {
  /** 受影响子树根集合；缺省/空 = 全量重排（等价 layoutTree）。 */
  changedRootIds?: ReadonlySet<string>;
}
export function layoutTreeIncremental(
  current: { positions: Record<string, LayoutPosition> },
  input: IncrementalLayoutInput,
  mode: LayoutMode,
): LayoutResult;
```

`LayoutResult / CollisionReport / MeasuredSize / LayoutPosition / DEFAULT_NODE_SIZE` 形状不变。
`pinned` 与新增 `manualFixed` 在内部合并为 `fixedSet` 统一避让；notes 中
「manualFixed：N 个节点保持手动坐标」与「固定锚点绕行：N 个节点被推出 pinned/manualFixed 遮挡」分列。

### 1.2 `graph/`（`packages/core/src/graph/graph.ts`，新增纯函数，不破坏既有 API）

```ts
// 祖先链：从 nodeId 沿 parent 指针向上到根（含自身），顺序 [self, parent, ..., root]。
export function getAncestorChain(tree: MainTree, nodeId: string): string[];

// 后代集合：nodeId 整棵子树（含自身），语义同 enumerateSubtree，命名面向聚焦。
export function getDescendantSet(tree: MainTree, nodeId: string): string[];

// 关联链（连通分量）：忽略边方向，返回 nodeId 所在连通分量（排序）；孤立点返回 [self]。
export function getRelatedChain(nodes: BlockNode[], edges: Edge[], nodeId: string): string[];

// 聚焦视图集合：focus = 祖先链 ∪ 子树；dim = 树中其余节点。均字典序排序。
export function getFocusViewSet(tree: MainTree, nodeId: string): { focus: string[]; dim: string[] };
```

## 2. radial 放射布局近似算法

入口：`layoutTree(input, 'radial')`，内部委托私有 `layoutRadialInto`。

1. **建树**：复用 `buildNestedTree`（首条入边 wins、折叠子树收叶、多根挂超根）。
2. **`cluster().size([2π, 1])`**：d3-hierarchy cluster 把全部叶子沿 x 均匀铺开在 `[0, 2π]`
   弧度上（绕满整圆、不回卷相撞），y 为归一化深度（弃用）。
3. **环半径 ringR[d]**（确定性，不随 d3 y）：
   - `ringR[0] = 0`（根在圆心）；
   - `ringR[1] = maxW + nodeSpacing`（第一环放宽，让根方框四周留出一圈，避免根与环 1 节点相切）；
   - `ringR[d] = ringR[d-1] + rankSpacing + 该层最大实测高`（环间距 = rankSpacing + 层最大尺寸）。
4. **角度居中**：`theta = d3.x − π`，映射到 `[-π, π]`。
5. **极坐标 → 直角**：`cx = r·sinθ, cy = r·cosθ`；块中心落在 `(cx,cy)`，
   左上角 = 中心 − (半宽, 半高)。
6. **归一化 / 锚点注入 / 绕行 / 碰撞复检**：与三树模式共用后续管线
   （最小左上归零、fixedSet 注入锚点、AABB 绕行、重叠对报告）。

**近似与局限（JSDoc 已声明，供 Wave4 知晓）**：
- 节点矩形是**轴对齐**而非沿切向摆放；叶子绕满整圆后相邻弧长在最外环最大、内环最小，
  内环小分支组在极端不等尺寸下仍可能轻微重叠 → 由最终 AABB 碰撞复检报告，不静默。
- 环间距用「该层最大实测高」近似，不等高树环高非最小包围。
- 多根（森林）时超根被丢弃，真实根落在 `ringR[1]` 上、圆心留空。
- `tighten` 对 radial 仅在 notes 层面提示；径向紧凑度未做切向收缩（保留近似）。

## 3. 增量整理「受影响集合」语义契约（供 store / 编辑器 Wave4 接线）

`layoutTreeIncremental(current, input, mode)` 是 Wave4 store 接线的稳定纯函数入口：

- **入参**：
  - `current.positions` = 上一次布局完整结果（`LayoutResult.positions`）。
  - `input.changedRootIds` = 调用方（store）判定的「受影响子树根」集合。
    store 负责在新增节点 / 移动节点 / 改父子关系时算出这些根 id；缺省（undefined 或空集合）=
    **全量重排**，等价于直接调 `layoutTree`。
- **受影响集合** = 各 `changedRootId` 的**整棵子树并集**（按 `input.edges` 推导，含自身、含新增后代）。
- **冻结节点** = 本次会被布局、但不在受影响集合、且在 `current.positions` 中有旧坐标的节点。
  - 它们被当作 pinned 锚点注入（`BlockNode.x/y = current.positions[id]`），布局在其周围绕行；
  - 输出坐标**严格等于 `current.positions[id]`**（函数末尾双重回填，逐字节不变）。
- **受影响节点**走完整 d3 重排；与冻结锚点重叠时沿用 pinned/manualFixed 绕行。
- **输出**仍是完整 `LayoutResult.positions`（未变部分原样回填）；确定性、可单测。
- notes 形如：`增量整理：受影响根 [b]（5 节点重排），3 节点保持原坐标。`

> Wave4 接线建议：store 在 applyLayout / 拖动改父子后，把「被改动的子树根」放入
> `changedRootIds`，把上一次 `positions` 作为 `current` 传入；这样未动分支不跳动、
> 撤销/重排之间坐标连续。

## 4. tighten 折叠收紧

- `LayoutInput.tighten === true` 时（仅对 mindmap-right / mindmap-down / org-tree 生效）：
  d3 `nodeSize` 改为 `[1,1]`（单位即 px），并用 `separation(a,b) = (w_a+w_b)/2 + nodeSpacing`
  按**实测宽**决定相邻叶子中心距；纵向行高仍按「逐行最大高 + nodeSpacing」累计（同 org-tree）。
- 效果：折叠掉大子树后，兄弟分支按真实宽度向心收拢，包围盒比默认（全局极值常量槽位）更紧凑；
  AABB 不重叠由 separation 间隙 + 行高累计保证，残留重叠进 `collisions.overlappingPairs`。
- 默认 `false`，保持 P0 既有行为不变（既有 P0 测试不回归）。

## 5. 测试清单（Vitest，确定性夹具）

layout（`layout/layout.test.ts`，19 例；原 9 例 + 新增 10 例）：
- 既有 9 例保持（mindmap-right/down/org-tree/DEFAULT/collapsed/pinned/子集/归一化）。
- 新增：
  1. radial：深度越大半径越大、同层无残留重叠、确定性输出（`expect(r1).toEqual(r2)`）。
  2. radial 与 right/down/org 切换：四模式结果字段完整、均返回 7 节点位置。
  3. radial 单独 describe：环形外扩、同层角度无 AABB 重叠、确定性。
  4. manualFixed：坐标不变 + detouredNodes 含 a + 无残留重叠 + notes 区分 manualFixed。
  5. tighten：折叠中间节点后无重叠、被折叠后代（d/e/f）无位置、notes 记录 tighten。
  6. tighten：不等宽节点下包围盒 ≤ 不收紧。
  7. incremental 缺省 changedRootIds = 全量（等价 layoutTree）。
  8. incremental：加一条边（b→h），未受影响分支 a/c/g 坐标逐字节不变。
  9. incremental：manualFixed 节点（c）在增量整理中坐标不变。

graph（`graph/graph.test.ts`，17 例；原 9 例 + 新增 8 例）：
- 新增：
  1. `getAncestorChain`：f→[f,c,a,root]、a→[a,root]、root→[root]、未知节点 []。
  2. `getDescendantSet`：a→{a,c,d,f}、b→{b,e}、root 全集、f→{f}。
  3. `getRelatedChain`：多分支连通分量含全部节点；孤立点返回 [self]。
  4. `getFocusViewSet`：聚焦 c → focus={a,c,f,root}、dim={b,d,e}；聚焦 e → focus={b,e,root}；
     聚焦 root → dim=[]。

合计 core 单测 **99 例**（P0 验收时 81 例 + 本 wave 新增 18 例），全部通过。
既有 P0 layout/paginate/store/model/serialize/smoke 测试无回归。

## 6. 与冻结契约的差异

- `LayoutMode` 字面量 `'radial'` 由「调用即抛错」改为已实现（符合规划 §4.5 P1 放射树）。
- `LayoutInput` 新增 `manualFixed?` / `tighten?` 两个可选字段（向后兼容，缺省行为不变）。
- `layoutTreeIncremental` 为新增导出，不改既有签名。
- graph 四个新函数为追加导出，不改 `buildMainTree/enumerateSubtree/connectedComponents` 等。
