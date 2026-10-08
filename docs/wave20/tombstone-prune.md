# Wave20 R 路 — 同步墓碑水位裁剪接进 web 传输层（pruneTombstones wiring）

把 Wave14 A 路在 `packages/core/src/sync/prune.ts` 已实现并单测固化的纯函数
`pruneTombstones(doc, { maxTombstones })`，正式接进 web 传输层
`packages/web/src/sync/orchestrator.ts` 的 `runSync`。此前 web 侧从未调用（全仓
`web/src` grep 无引用），长期高频删除的同步文档墓碑表（`sync.nodes[*].t` /
`sync.edges[*].t`）在本地库与远端 `.kbnote` 里无界增长。本波把它压回阈值。

接线契约严格照 `docs/wave14/tombstone-bounds.md` §5，未改 core 已发布行为。

---

## 1. 接线点与时序

统一经一个小 helper `pruneDocTombstones(doc, result)`（orchestrator 内部）：

```
pruneTombstones(doc, { maxTombstones: DEFAULT_MAX_TOMBSTONES /* =1000 */ })
```

- 输入 doc = **本轮收敛后的文档自身**；用**文档自身合并后的 `sync.vv`** 派生安全水位
  `W = min(vv[c])`，**不用任一对端单独发来的 vv**（合并 vv 才是本轮所有已知客户端的并集）。
- 顺序必须在 `syncStamper.stampForPersist(doc)` **之前**：裁剪后的 doc 才盖章、才落盘/推送。

两条接线路径：

### pull / merge 路径（orchestrator 4b）

```
mergeSnapshots(local, remote, base)  →  merged
        │
        ▼
pruneDocTombstones(merged, result)   ← merge 收敛后、落库前
        │  merged = pruned.doc
        ▼
storageAdapter.saveDoc(merged)       ← 落盘的是裁剪后文档
applyRemoteDoc(merged)（仅打开文档）
writeBase(id, merged)                ← base 也是裁剪后文档
```

`localDoc == null`（远端独有）时 `merged = remoteDoc`，同样过裁剪——保证拉下来的
远端墓碑表在本地也被有界化。

### push 路径（orchestrator 4a）

```
db.docs.get(id)  →  raw
        │
        ▼
pruneDocTombstones(raw, result)      ← stampForPersist 之前
        │  doc = pruned.doc
        ▼
stamped = syncStamper.stampForPersist(doc)
channel.pushDoc(id, serializeKBNote(stamped))
writeBase(id, stamped)
```

push-only 文档同样执行裁剪（硬验收⑤）。

> 说明：push 路径本就不回写本地库（仅推远端 + 写 base）。本地 push-only 文档的墓碑表
> 在「首次推送后、下一轮双向合并」时由 4b 落库路径自然裁剪收敛——这是 P2P 无服务器
> 模型下每轮同步自然推进的预期行为，不引入新的回写路径以避免与正在编辑的打开文档产生
> 写竞争。

## 2. 安全水位语义（不变，引自 Wave14）

- `W = min over 已知客户端 c 的 vv[c]`；vv 空 → W=0，一条都不裁。
- 墓碑 `[L, D]` 可裁 ⟺ `L ≤ W`（所有已知客户端都已因果观测到这次删除）。
- 阈值内（`total ≤ 1000`）一律不裁；超限只在安全集合内**最老优先**裁到 1000。
- **安全集合不够就停手**：宁可墓碑数暂时超过 1000，也绝不越安全线裁不安全墓碑
  （硬验收②固化此行为）。

## 3. 统计字段（SyncRunResult 自加，可选观测）

| 字段 | 含义 |
|---|---|
| `prunedTombstones` | 本轮被裁剪的墓碑总数（节点+边） |
| `prunedEdgeTombstones` | 被裁剪的边墓碑数（前者子集） |
| `retainedTombstones` | 裁剪后仍保留的墓碑总数（跨本轮处理文档求和） |
| `tombstoneWatermark` | 最后一次裁剪调用观测到的安全水位 W=min(vv) |

仅 `console.debug` 级日志（`[sync] tombstone prune ...`），**不弹 UI、不打扰用户**。
`SyncRunResult` 经 `syncController.inspect().lastRun` 暴露给 e2e 观测。

## 4. 不破坏的既有逻辑（红线自检）

- **ConflictCopies**：冲突副本只在 4b 的 `conflicts.length > 0` 分支写远端副本 + 注册表，
  裁剪发生在其之前且只删墓碑 meta，不影响冲突检测与副本命名/登记。
- **asset push 去重 / 幂等**：裁剪只动 `sync.nodes`/`sync.edges` 里的墓碑 meta 记录，
  不碰 `assetRefs`；资产去重仍按 `assetRefs` ∪ 远端清单算 missing，完全不受影响。
- **不绕过 merge**：裁剪是「本地遗忘」。对端仍持有的墓碑，下一轮 `mergeSnapshots` 在
  「两侧都不在数组」分支会把较新墓碑自然带回（`outMeta[id] = { t: tombB }`），
  被删实体不复活（硬验收③）。

## 5. 测试证据

### vitest 集成测（硬门）`packages/web/src/sync/orchestrator.prune.test.ts`

fake/in-memory `SyncChannel` + 内存 Dexie 替身，仿现有 sync 测试范式：

1. **全覆盖压阈值**：1200 安全墓碑、vv={A:1500} → 落盘 1000，最老 200 条（n1..n200）被裁，
   `prunedTombstones=200 / retainedTombstones=1000`。
2. **落后 client 不越线**：vv={A:1500, B:10}（W=10）→ 仅裁安全的 n1..n10，保留 1190 条
   （>1000），n11（L=11>W）保留。
3. **对端持墓碑再 merge**：本地缺 n1、对端持 n1 → 合并后 n1 墓碑恢复，n1 不进 nodes 数组（不复活）。
4. **≤阈值 no-op**：500 墓碑 → `prunedTombstones=0`，全部保留（引用稳定语义）。
5. **push-only 路径**：本地独有 1200 墓碑 → 推送出去的文档压到 1000。

### e2e `packages/web/e2e/wave20-tombstone-prune.spec.ts`

经 dev-hook `syncSeedTombstoneDoc(1050)` 注入合成墓碑（lamport 全部 ≤ vv，全安全），
走真实 FSA fake 通道跑一轮同步，断言：
- `inspect.lastRun.prunedTombstones === 50`、`retainedTombstones === 1000`、
  `tombstoneWatermark === 1050`；
- 推送到 fake 目录的 `.kbnote` 墓碑数为 1000。

> 降级说明：真实造 1000+ 删除太重，e2e 用合成墓碑注入（仅测试 action，DEV-only，
> 生产构建 tree-shake）。5 场景的正确性由 vitest 集成测作硬门，e2e 只做
> 「阈值生效 + SyncRunResult 统计可观测」的真实通道冒烟。

## 6. 边界

- 未改 `packages/core/src/sync/prune.ts`（已发布）；core 仅经既有桶导出复用，零改动。
- FSA / WebDAV / 手动备份通道都经同一 `runSync` 编排，一处接线全通道生效。
- web 业务 UI 不动；不改 workflow；分支 `feat/sync-tombstone-prune`。
