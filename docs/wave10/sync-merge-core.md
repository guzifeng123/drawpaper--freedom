# Wave 10 阶段 A — 跨设备同步合并内核（契约冻结）

`packages/core/src/sync/`：纯 TS、零 DOM/React/宿主 API。用户经自有 WebDAV / 同步盘文件夹在多设备间同步 `.kbnote`，**无官方服务器**。合并语义复用 Wave9 collab（Lamport 全序 / 字段级 LWW / 墓碑 / 冲突摘要）。阶段 B（FSA / WebDAV 传输通道）按本文导出的 API 实现。

---

## 1. v3 持久化元数据形状（`SyncBlock`）

挂在 `KBNoteDoc.sync`，随 `.kbnote` 落盘。紧凑设计：**字段时钟只存 `[lamport, clientId]`，不存 value**（value 已在节点/边/文档本体上，合并时直接读本体）。

```ts
// packages/core/src/sync/types.ts
type FMarkTuple = [lamport: number, clientId: string];   // = EventMarker 的持久化形式

interface EntitySyncMeta {
  f?: Record<string, FMarkTuple>;  // 字段时钟：缺失字段 = 未单独时钟化
  t?: FMarkTuple;                  // 墓碑：存在即该实体已删除（本体已移出 nodes/edges 数组）
}

interface SyncBlock {
  vv: Record<string, number>;                // 版本向量：clientId → 最高 lamport
  docF?: Record<string, FMarkTuple>;         // 文档级字段（title）
  pageF?: Record<string, FMarkTuple>;        // 分页字段
  nodes?: Record<string, EntitySyncMeta>;    // nodeId → meta
  edges?: Record<string, EntitySyncMeta>;    // edgeId → meta
}
```

- 参与字段级 LWW 的字段集与 collab 对齐（`NODE_CLOCKED_FIELDS` / `EDGE_CLOCKED_FIELDS` / `DOC_CLOCKED_FIELDS` / `PAGE_CLOCKED_FIELDS`）。边 `color` 持久化为字段键 `color`，合并时映射到 `edge.style.color`。
- `KBNoteDocSchema` 新增 `sync: SyncBlockSchema.default({ vv: {} })`；`serializeKBNote` 输出 `sync` 键。
- `CURRENT_DOC_VERSION = 3`。

## 2. 合并语义（`mergeSnapshots`）

```ts
function mergeSnapshots(local: KBNoteDoc, remote: KBNoteDoc, base?: KBNoteDoc): MergeResult;
interface MergeResult {
  doc: KBNoteDoc;            // 合并后的新文档（纯函数，不改入参）
  conflicts: CollabConflict[]; // 复用 collab 的 CollabConflict 形状
  summary: string[];         // = summarizeConflicts(conflicts) 中文摘要
}
```

- **字段级 LWW**：lamport 大者胜；相等时 clientId 字典序小者胜；同值平局不记冲突。
- **三路（提供 base）**：仅当 local 与 remote **都相对 base 改了同一字段且取值不同**才算并发冲突；只一方改 → 静默快进，不报假冲突。`parentId` 并发 → `kind: 'reparent'`。
- **两路（无 base）**：退化为「两端字段戳不同且取值不同即冲突」的保守 LWW。
- **删除优先 + 墓碑**：一方删除（`meta.t`）、另一方编辑 → 墓碑胜（不复活），败方编辑写入 `conflicts`（`field: '<deleted>'`，`reason` 记录删除语义），不静默丢数据。
- **新增传播**：仅一侧见过、对方无墓碑的实体 → 视为对方尚未同步到的新增，保留。
- **幂等 / 收敛**：同一 remote 重复合入结果文档不变；合并满足交换律（`merge(A,B) ≡ merge(B,A)`），`A→B→A` 环回收敛（见单测）。
- `assetRefs` / `links` / `tags` 取并集去重；`vv` 逐分量 max；`board.updatedAt` 取 max。
- `docId` 不匹配抛错（调用方按 docId 路由）。

## 3. v2 → v3 确定性迁移证明

`MIGRATION_REGISTRY[2] = migrateV2ToV3`（`sync/migrate.ts`），`MIGRATION_NOTES[2]`。

**确定性来源（全部来自文件本身，零随机/零 Date.now）**：

| 量 | 取值 |
|---|---|
| lamport 基线 | `floor(board.updatedAt)`；≤0 回退 `board.createdAt`；仍 ≤0 取 `1` |
| clientId 种子 | `seed:<docId>`（由文档 id 派生） |
| 节点/边逐记录戳 | v2 无逐记录时间字段 → 全部继承同一文档级戳 `[baseLamport, seedClientId]` |

**证明**：同一 v2 档在两台设备升级 → lamport 取自同一文件的 `board.updatedAt`，clientId 由同一 `docId` 派生 → 逐节点/边/文档/分页字段的戳完全一致（单测 `toEqual`）。两端首次 `mergeSnapshots` → `conflicts.length === 0`（无假冲突）。

**B 端约定**：加载 v3 后必须把本端 Lamport 时钟抬到 `adoptClockFloor(doc)`（= `maxPersistedLamport(doc)`）再 `tick()`，否则本地新编辑会输给迁移戳。

## 4. Manifest / diff / 增量分片 / 水位

```ts
interface DocManifest {
  id: string; title: string; hash: string; version: number;
  vv: VersionVector;
  tombstones: { nodes: string[]; edges: string[] };
  assets: string[];          // 当前 = assetRef id（B 端可按内容 hash 命名以去重）
  modifiedAt: number;
}
interface SyncManifest { deviceId: string; docs: Record<string, DocManifest>; }

function manifestFromDoc(doc: KBNoteDoc): DocManifest;
function diffManifests(local: SyncManifest, remote: SyncManifest): Record<string, DocSyncStatus>;
// DocSyncStatus = equal | local-only | remote-only | local-ahead | remote-ahead | concurrent

interface SyncBundle { pushDocIds: string[]; pullDocIds: string[]; mergeDocIds: string[]; missingAssets: string[]; }
function planBundle(local: SyncManifest, remote: SyncManifest): SyncBundle;

interface SyncCursor { vvByDoc: Record<string, VersionVector>; }
function emptyCursor(): SyncCursor;
function advanceWatermark(cursor: SyncCursor, mergedDoc: KBNoteDoc): SyncCursor;
function hasUnsyncedChanges(cursor: SyncCursor, doc: KBNoteDoc): boolean;
function mergeCursors(a: SyncCursor, b: SyncCursor): SyncCursor;
```

- `hash` = `canonicalHash(content)`（FNV-1a over 键序递归排序 JSON，剔除 `sync`），纯函数、无 crypto 依赖。
- 资产：`missingAssets` = 对端有、本端无的资产标识集合差；二进制按 hash 去重传输（core 不碰二进制 IO）。
- `diffManifests`：同 id 两边都有 → 用 `compareVersions` 判 `equal/local-ahead/remote-ahead/concurrent`；单边存在 → `local-only/remote-only`。
- 水位：`advanceWatermark` 在一轮同步成功后记录合并 vv；`hasUnsyncedChanges` 判本端是否还有未同步事件。

## 5. 给阶段 B（传输通道）的接入清单

1. 扫描同步盘/WebDAV 文件夹 → 逐文档 `parseKBNote` → `manifestFromDoc` 构造 `SyncManifest`（`deviceId` 由 B 端提供）。
2. `diffManifests(localM, remoteM)` → `planBundle`：
   - `pushDocIds`：上传本端 `.kbnote`；
   - `pullDocIds`：下载对端 `.kbnote`；
   - `mergeDocIds`：下载对端 `.kbnote` 后 `mergeSnapshots(local, remote, base?)`（base = 上次同步点，可选但强烈建议传，避免假冲突）；
   - `missingAssets`：按资产标识拉取缺失二进制（已去重）。
3. 合并成功后 `advanceWatermark(cursor, mergedDoc)`，把合并结果写回 `.kbnote`（`serializeKBNote`）。
4. 时钟：建 store 前 `createLamportClock(adoptClockFloor(doc))`；每处本地编辑产出的 op 信封带真实 `clientId` 与递增 lamport，并写入对应字段的 `sync.*.f[field] = [lamport, clientId]` 与 `vv[clientId] = max(...)`。
5. 冲突 UI：直接渲染 `mergeSnapshots(...).summary`（中文）。

## 6. 已知遗留 / 待 B 决策

- 墓碑集有界化（`pruneTombstones` 的 watermark 策略）留待 B 端在确认所有对端 VV 超过水位后裁剪。
- `base` 当前主要服务「未偏离侧快进」；墓碑被裁剪后的「删除-新增二义恢复」是扩展点。
- 资产标识当前复用 `assetRef`（nanoid，非内容寻址）；B 端若做内容寻址去重，可在 `planBundle.missingAssets` 之上再按内容 hash 去重，core 侧无需改动。
- `links` / `tags` 当前并集去重，不做字段级 LWW（与 collab 的数组整体 LWW 语义一致）。
