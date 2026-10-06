# Wave 14 A 路 — 同步墓碑水位裁剪（pruneTombstones）

`packages/core/src/sync/prune.ts`：纯 TS、零 DOM/宿主 API。落地 Wave10 §6 / sync-channels §10
遗留的「墓碑集有界化」。传输层（web 侧，本波不实现）在一轮同步收敛后调用本函数，把无界增长的
墓碑表压回阈值内，同时绝不触发被删实体复活。

---

## 1. 函数签名

```ts
// packages/core/src/sync/prune.ts（经 sync/index.ts 桶导出）
export const DEFAULT_MAX_TOMBSTONES = 1000;

export interface PruneTombstonesOptions {
  /** 墓碑数量上限。当前墓碑数 ≤ 该值时不裁；超出时仅在安全集合内按最老优先裁到该值。
   *  允许 0（= 裁掉全部安全墓碑）；负数 / NaN 回退默认值。默认 1000。 */
  maxTombstones?: number;
}

export interface PruneTombstonesResult {
  doc: KBNoteDoc;                 // 裁剪后新文档（纯函数，不改入参；未触发裁剪返回同一引用）
  prunedNodes: string[];          // 被裁节点 id（最老优先顺序）
  prunedEdges: string[];          // 被裁边 id
  prunedCount: number;           // 实际裁剪条数
  watermark: number;              // 安全水位 W = min(vv[c])
  retainedCount: number;         // 裁剪后仍保留的墓碑总数
}

export function pruneTombstones(
  doc: KBNoteDoc,
  options?: PruneTombstonesOptions,
): PruneTombstonesResult;

// 单独导出的水位计算（便于传输层/调试复用）：
export function safeTombstoneWatermark(vv: Record<string, number> | undefined | null): number;
```

墓碑的持久化形状（见 `types.ts`，不变）：

```ts
type FMarkTuple = [lamport: number, clientId: string];
interface EntitySyncMeta { f?: Record<string, FMarkTuple>; t?: FMarkTuple }
// t 存在即墓碑：实体本体已从 nodes/edges 数组移除，t=[删除 lamport, 删除客户端]。
```

## 2. 安全条件推导（watermark / stable-time）

版本向量 `sync.vv: Record<clientId, number>` 中 `vv[c]` = 已知客户端 c 已生成（tick）到的
最高 Lamport。Lamport 时钟的因果性质：**客户端 c 一旦生成了 lamport ≥ W 的事件，它必然已经
观测到所有 lamport < W 的事件**（observe 远端事件时时钟跳到 max，再 tick 出新值）。

由此定义**安全水位**：

```
W = min over 已知客户端 c 的 vv[c]      // vv 为空时 W = 0
```

- 某条墓碑 `[L, D]`（D 在 lamport L 删除了实体）**可裁 ⟺ L ≤ W**。
  - 含义：每个已知客户端 c 都已生成过 lamport ≥ L 的事件 → 都因果观测到了这次删除。
- **L > W 的墓碑绝不裁**：存在某个已知客户端 c 的 `vv[c] < L`，无法证明 c 已观测该删除；
  若此时裁掉，c later 带着旧本体重放，`mergeEntitySet` 在「b 在数组、a 不在、a 无墓碑」分支
  会把旧实体捞回来 → 被删实体复活。

为什么用 `min(vv)` 而不是「墓碑删除者 D 的 `vv[D]`」：删除者自己一定观测到自己的删除
（`vv[D] ≥ L` 恒成立），但其它客户端未必；`min` 把「最落后的已知客户端」当作全局水位，
任何超过它的删除都还可能被最落后客户端重放，必须保留。

### 安全边界

- `L === W`：视为安全（最落后客户端恰好已越过该删除）。
- `vv = {}`（全新设备 / 尚未交换任何状态）：`W = 0`，所有 `L ≥ 1` 的墓碑都不裁 —— 此时
  对系统里有哪些其它副本一无所知，保守是对的。
- 坏输入（vv 含 NaN / 字符串 / 负数）：`safeTombstoneWatermark` 忽略非有限数；全坏时 `W = 0`，
  函数不抛。

## 3. 阈值策略

```
total = 当前墓碑总数（sync.nodes[*].t + sync.edges[*].t）

if total ≤ maxTombstones:
    不裁（prunedCount = 0，原样返回）
else:
    eligible = [c ∈ 墓碑 | c.lamport ≤ W]      // 仅安全集合
    eligible.sort(byOldest = lamport 升序, 同 lamport 按 clientId 升序)
    need = total - maxTombstones
    裁掉 eligible 的前 need 条（最老优先）
```

- **阈值内不裁**：墓碑在预算内就保留全部，避免无谓抖动。
- **最老优先**：越老的墓碑越可能已被所有客户端观测；超预算时先丢最老的、最安全的。
- **安全集合不够就停**：若 `eligible.length < need`，只裁 `eligible` 全部，宁可让墓碑数暂时
  超过 `maxTombstones`，也绝不越安全线去裁不安全墓碑（单测固化此行为）。
- 裁剪动作 = 从 `sync.nodes` / `sync.edges` 中**整条删除该 id 的 meta 记录**（墓碑实体的
  本体早已不在数组里，其字段时钟随删除胜负已被 `mergeEntitySet` 简化为仅 `{ t }`）。

## 4. 与 mergeSnapshots / cursor 的协作

- **裁剪后再合入「仍含该墓碑」的远端状态不会复活**：`mergeEntitySet` 在「两侧实体都不在数组」
  分支（merge.ts 末段）会比较两侧墓碑并传播较新者。本端已裁（`tombA = undefined`）、对端仍有
  `tombB` 时，结果 `outMeta[id] = { t: tombB }` —— 墓碑由对端**自然恢复**，删除态保持、不产生
  假冲突。这正是「裁剪只是本地遗忘，不是全局宣告删除结束」的语义。
- **删除-新建二义**：裁剪后若某对端以更高 lamport 重建了同名实体（recreate），合并时该实体在
  对端数组里、本端无墓碑 → 走「b 在数组、a 不在、a 无墓碑」分支取对端较新本，较新重建生效，
  不会复活旧的被删版本。这是预期收敛（单测覆盖）。
- **与 cursor/水位工具一致**：`advanceWatermark(cursor, mergedDoc)` 记录的是「合并后 vv」；
  `pruneTombstones` 用同一 vv 的 `min` 派生安全水位。二者都只依赖 `SyncBlock.vv`，风格对齐
  manifest.ts 的纯函数（不碰 IO、不改入参、返回新对象）。
- **幂等 / 收敛**：对已裁剪状态重复调用，剩余墓碑数 ≤ 阈值 → 直接返回同一引用；与
  `mergeSnapshots` 的交换律、环回收一起保证裁剪不破坏最终一致。

## 5. 给传输层（web 侧，本波不实现）的接线建议

1. **调用时机**：每轮 `orchestrator.runSync` 成功、`mergeSnapshots` 收敛并 `advanceWatermark`
   之后、`serializeKBNote` 落盘之前，对合并结果文档跑一次
   `pruneTombstones(mergedDoc, { maxTombstones })`。把返回的 `doc` 落盘，再用
   `prunedCount / retainedCount / watermark` 写日志（可选）。
2. **以谁的 vv 为准**：就用**合并后文档自身的 `sync.vv`**（即 `advanceWatermark` 记录的那份）。
   不要用某一台对端单独发来的 vv —— 合并 vv 才代表「本轮所有已知客户端的并集」，`min` 取的是
   本轮见过的最落后副本。
3. **阈值取值**：默认 `1000` 墓碑/文档足够；可按文档规模调。低内存设备可调小，但**不要调 0
   之外的「激进」值去强求裁剪** —— 安全集合不够时函数会自动停手。
4. **裁剪是本地优化，不是全局 gc**：本端裁掉的墓碑，在与仍持有它的对端合并时会被对端重新带回。
   这意味着：只有当**所有**客户端都在同步后各自裁剪过同一个墓碑（即大家的 `min(vv)` 都越过了
   它的 lamport），它才会真正从系统里消失。传输层无需协调，让每轮同步自然推进即可。
5. **未知 / 离线很久的客户端**：若某客户端长期离线（从未进入本轮 vv），它对 `min(vv)` 无贡献，
   但它手里可能握着旧本体。本函数的「全部已知客户端」语义以**本轮同步见过的客户端集合**为准；
   若传输层知道有客户端长期未同步，应在再次与之同步**之前**不要指望它删除的墓碑已被全局安全 ——
   这是 P2P 无服务器模型的固有边界，已在单测中以「缺一个 client VV 不裁」固化。

## 6. 单测覆盖（prune.test.ts，19 例）

- 水位计算：min、空 / null / NaN → 0。
- 安全第一：缺一个 client VV（`vv[c] < L`）的墓碑绝不被裁；全覆盖后可裁；`L === W` 边界可裁。
- 阈值：恰好（不裁）/ 超一条（裁最老）/ 不足（不裁）/ 安全集合不足时宁可超阈值也不越线。
- 最老优先：跨节点+边混合，按 lamport、同 lamport 按 clientId 升序。
- 幂等 + 不可变：重复裁剪结果不变；入参文档深等不变。
- 与 mergeSnapshots 协同：裁剪后合入仍含墓碑的远端 → 墓碑恢复、不复活；删除-新建二义取较新本。
- 空状态 / 无墓碑 / 坏 vv / 坏 options / 缺 sync：不抛、不裁。
