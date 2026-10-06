# Wave 9 · 同浏览器多标签实时协作协议（阶段 A：契约冻结）

> 范围：`packages/core/src/collab/`（纯 TS、零 DOM/React、零网络库、未引入 yjs/任何 CRDT 库）。
> 本阶段冻结「类型 + zod schema + 纯函数合并引擎 + 单测」；阶段 B 由 web 侧落地
> `BroadcastChannel` 传输与 UI（选区高亮、冲突横幅），**以本文与 core 导出 API 为准**。

## 1. 设计前提与边界

- **存储是同源共享 IndexedDB（Dexie）**：多标签本就共享同一份落盘数据。本协议**不做持久化同步层**，
  只负责「实时传播 + 并发安全合并」。late-joiner 直接读 Dexie 拿到已落盘 doc，快照消息只对齐
  **未落盘的近期变更**。
- **core 铁律**：不出现 `window/document/BroadcastChannel/setTimeout` 等宿主 API。
  传输层是阶段 B 的职责；core 只输出纯函数与类型。
- **身份生命周期**：clientId 在 tab 存活期内稳定；刷新后是否恢复由 B 端从 sessionStorage 决定，
  core 不碰 sessionStorage。

## 2. 身份与时钟

### 2.1 标签身份
| 符号 | 说明 |
|---|---|
| `ClientId = string` | `c_` + nanoid(10)，`generateClientId()` |
| `TabIdentity` | `{ clientId, name, color }`；`name` 用户可编辑（缺省 `未命名标签页`）；`color` 取自 `TAB_COLOR_PALETTE`（8 色），`pickTabColor(seed)` 按 seed 取模确定性挑选 |

### 2.2 Lamport 时钟
`createLamportClock(initial=0)` → `{ value, tick(), observe(remote) }`
- `tick()`：发送前 `value+1`，返回新时间戳。
- `observe(remote)`：`value = max(value, remote) + 1`。**永不回拨**——远端旧时间只让本端自增 1；
  远端领先则向前跳变（覆盖时钟回拨场景）。

### 2.3 确定性全序（同 Lamport 同帧并发的决序）
`compareEvents(a, b)`：
1. 主关键字 Lamport 升序；
2. 次关键字 **clientId 字典序，小者排后（视为更晚 = LWW 胜方）**。

`lwwBeats(candidate, incumbent)` = `compareEvents(candidate, incumbent) > 0`。
同一事件定位 `(lamport, clientId)` 在全序中唯一，乱序重放任何两端都收敛到同一结果。

### 2.4 版本向量
`VersionVector = Record<ClientId, number>`。
- `compareVersions(a,b)` → `'before' | 'after' | 'concurrent' | 'equal'`。
- `mergeVersions(a,b)` 逐分量取 max（late-joiner 对齐时合并基线 VV 与本端 VV）。

## 3. 信封（Envelope）

统一头部：
```ts
interface EnvelopeHeader {
  v: 1;               // 协议版本；不符直接拒（version-mismatch）
  docId: string;
  clientId: ClientId;
  tabName: string;     // 默认「未命名标签页」
  tabColor: string;
  lamport: number;     // 发送方逻辑时钟
}
```

判别联合（`kind`）：

| kind | 载荷 | 用途 |
|---|---|---|
| `op` | `{ opId: string; op: CollabOp }` | 一条文档变更；opId 全局唯一（`op_`+nanoid），幂等去重键 |
| `presence` | `PresenceState` | 现场状态：当前 docId、选区节点 id 列表、hoverNodeId、飞块矩形 `{x,y,w,h}`、heartbeatSeq。**不进合并引擎、不写 doc** |
| `snapshot-request` | `{ requestVv: VersionVector }` | late-joiner 请求对齐 |
| `snapshot` | `{ baseline: KBNoteDoc; baseVv; ops: OpEnvelope[] }` | 持有方回基线 + 基线 VV + 增量 op |

### 3.1 op payload 类别（`CollabOp` 判别联合）
| kind | payload | 对齐 store 命令 |
|---|---|---|
| `add-node` | `{ node: BlockNode }` | addNode / addNodes（逐条）/ add-image-block |
| `delete-nodes` | `{ nodeIds: string[] }` | deleteNode(s)（自动级联墓碑入射/出射边） |
| `update-node` | `{ nodeId, patch: NodeFieldPatch }` | updateContent / moveNode / resizeNode / updateNodeStyle / togglePin/Lock/Collapse/Todo / setBlockType / add/removeTag / reparent(parentId) |
| `add-edge` | `{ edge: Edge }` | addEdge / link-child / link-sibling |
| `delete-edge` | `{ edgeId }` | deleteEdge / unlink-parent |
| `update-edge` | `{ edgeId, patch: EdgeFieldPatch }` | setEdgeColor / setEdgeLabel / setEdgePoints / clearEdgePoints |
| `move-nodes` | `{ positions: {nodeId,x,y}[] }` | 一键布局 / 多选手势批量落位 |
| `set-doc-meta` | `{ patch: { title? } }` | renameDoc |
| `set-page` | `{ patch: PagePatch }` | setPageSettings / add/remove/setPageBreaks |

`NodeFieldPatch` 可字段：`x/y/width/height/content/parentId(null=解挂)/pinned/locked/collapsed/tags/style/type/todo?/image?/heading?/bookmark?/attachment?/reminder?`（`?` 字段 `null` = 清除）。
`EdgeFieldPatch` 可字段：`source/target/sourceHandle/targetHandle/label/color(→style.color)/points?(null=清除弯折点)`。

> **数组字段语义**：`tags/points/pageBreaks` 一律按「整体值寄存器」LWW，不做集合合并。
> 需要并集语义时由 B 端在其上做差量。

### 3.2 序列化与校验
- `serializeEnvelope(env): string`；`parseEnvelope(raw: string | object): CollabEnvelope`。
- 坏消息抛 **`CollabProtocolError`**（`.code: 'bad-json' | 'bad-envelope' | 'version-mismatch' | 'bad-doc'`），
  B 端必须 catch 后丢弃该消息，**不应用任何状态**（单测覆盖「坏消息不改变状态」）。

## 4. 合并引擎（`applyOp(state, env): ApplyResult`）

`CollabState = { doc, vv, nodeMeta, edgeMeta, docFields, pageFields, appliedOpIds, log, clock }`。
- `nodeMeta/edgeMeta: Record<id, { tombstone, fields }>`；`fields` 是 `Record<字段名, {lamport, clientId, value}>`。

### 4.1 幂等
1. `opId` 已在 `appliedOpIds` → `outcome='duplicate'`，原样返回（doc 零拷贝）。
2. 否则更新 VV（`vv[clientId]=max(...)`）、应用载荷、登记 opId、追加 log。

### 4.2 字段级 LWW
对 patch 的每个字段：
- 无历史写入 → 直接落；
- 历史写入者是同一 client → 直接盖（自己的新写）；
- 历史写入者是他方：值相同 → 收敛无冲突；否则按 `lwwBeats` 裁决——**胜方值落 doc，败方写入 `conflicts`**。
- 不同字段并发修改互不干扰，双方都保留。

### 4.3 删除优先 + 墓碑
- `delete-nodes/delete-edge`：打 `tombstone={lamport, clientId}`，实体移出 doc，级联墓碑关联边。
- 到达墓碑实体的 `update-*`：一律压制（`suppressed-tombstone`），不复活。
- 到达墓碑实体的 `add-*`（重建）：**仅当 `lamport > tombstone.lamport` 才允许复活**（严格大于；
  同 lamport 删除优先）。

### 4.4 分叉冲突
并发写同一字段不同值即记一条 `CollabConflict`：
```ts
interface CollabConflict {
  entity: 'node' | 'edge' | 'doc' | 'page';
  entityId: string | null;
  field: string;          // parentId → kind 'reparent'，其余 'field-lww'
  kind: 'reparent' | 'field-lww';
  winner: { clientId, lamport, value };
  loser:  { clientId, lamport, value };
  reason: string;         // 机器可读原因
}
```
- 成环：core 不强制；应用后 B 端用既有 `detectConflicts`（graph 模块）弹窗。
- 人类可读摘要：`describeConflict(c, names?)` / `summarizeConflicts(list, names?)`，
  中文文案模板见下，UI 横幅/列表可直接渲染。

```
「左屏」与「右屏」同时把节点「n1」改挂到不同父节点：左屏 挂到「pA」，右屏 挂到「pB」。已保留 左屏 的结果（Lamport 5），右屏 的改动因并发冲突未生效。
```

## 5. Late-joiner 流程

```
新标签 B                       持有标签 A
  │                             │
  │── snapshot-request ───────▶│  (requestVv = B 的 VV)
  │   (B 已读 Dexie 拿到 doc)   │
  │◀──── snapshot ──────────────┤  baseline=A.doc, baseVv=A.vv,
  │   applySnapshot(B, snap)    │  ops = A.log 中 B 未见过的增量
  │   1) zod 校验基线            │
  │   2) 换基线 doc              │
  │   3) 按 (lamport,clientId)  │
  │      全序重放 ops            │
  │   4) opId 幂等跳过重复       │
```
- `applySnapshot` 合并基线 VV 与本端 VV（逐分量 max），本端已发但基线未含的 op 不回退。
- 输出 `{ state, conflicts（未解决并发冲突）, replayed }`。
- 坏基线抛 `CollabProtocolError('bad-doc')`，不动 B 状态。

### 5.1 墓碑压缩
- `pruneTombstones(state, watermark)`：丢弃 `lamport ≤ watermark` 的墓碑。
  安全前提：watermark = 所有对端已确认的最小 VV 分量（B 端维护 peers 表后决定）。
- `pruneAppliedOps(state, keep)`：opId 表与 log 只留最近 `keep` 条（有界化）。
- `compactCollabState(state, { tombstoneWatermark, keepAppliedOps })`：组合。

## 6. 命令 ↔ op 映射（`commands.ts`，纯构造器）

B 端在 `runCommand` 成功后：`clock.tick()` → 调下列构造器打包 → `BroadcastChannel.postMessage(serializeEnvelope(env))` →
再把**同一条 env 喂回本端 `applyOp`**（本端与远端走同一条收敛路径）。

| 构造器 | 对应 store action |
|---|---|
| `opAddNode(h, node)` / `opAddEdge(h, edge)` | addNode / addEdge |
| `opDeleteNodes(h, ids)` / `opDeleteEdge(h, id)` | deleteNodes / deleteEdge |
| `opUpdateNode(h, id, patch)` | updateContent/moveNode/resizeNode/updateNodeStyle/toggle*/reparent |
| `opMoveNodes(h, [{id,x,y}])` | 布局/批量移动 |
| `opUpdateEdge(h, id, patch)` | setEdgeColor/Label/Points |
| `opSetDocMeta(h, {title})` | renameDoc |
| `opSetPage(h, patch)` | setPageSettings / pageBreaks |

反向：B 端收到 `op` 后**不再调 runCommand**，而是直接用 `applyOp` 的结果 `state.doc` 替换 store doc
（远端 op 不进 undo 栈；本地 undo 只针对本地命令）。

## 7. 给阶段 B 的接入清单

1. 每个打开的 doc 建一个 `createCollabState(loadedDoc)` + 一个 `createLamportClock()`。
2. `BroadcastChannel('drawpaper-collab:' + docId)`；收消息先 `parseEnvelope`（catch 丢弃）。
3. `op` 信封 → `applyOp` → 把 `state.doc` 写回 store；把 `result.conflicts` 推 UI。
4. `presence` 信封 → 更新 peers 表，画远端光标/选区。
5. 打开文档后广播 `buildSnapshotRequest({...})`；收到 `snapshot` → `applySnapshot`。
6. 心跳：presence 每 N 秒发一次，`heartbeatSeq+1`；对端超时未见心跳则从 peers 移除。
7. `CollabAdapter`（store/adapters.ts 预留接口）可在 B 端实现为持有上述状态的适配对象，
   **本阶段不改其形状**。

## 8. 遗留与待 B 决策点

- **落盘历史无字段时钟**：`createCollabState(loadedDoc)` 把既有实体按 lamport=0 播种，
  即「任何后来 op 都在其之上」。长时间运行后建议定期把 `CollabState` 元数据随 doc 一起落盘（本阶段未做）。
- **tags/points/pageBreaks 是整体寄存器**：并发往 tags 加不同标签会互相覆盖而非并集，已知取舍。
- **opId/log 上限**：B 端需周期性 `compactCollabState`；watermark 取值依赖 peers VV 表。
- **远端 op 不进 undo 栈**：undo 仅本地手势；远端修改覆盖后本地 undo 行为由 B 端决定（建议禁用 undo 直到状态稳定）。
- **reparent 的边编排**：`update-node{parentId}` 与 `add/delete-edge` 的原子打包顺序由 B 端决定
  （core 把边当一等实体独立收敛）。
