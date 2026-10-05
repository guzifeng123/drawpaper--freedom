# Wave6a · schema v2 版本迁移地基

> 范围：`CURRENT_DOC_VERSION` 1→2；`Edge.points`；新 `links` 反链索引；v1→v2 迁移步注册；
> web 侧高版本提示 + FSA 写盘门控。本路为后续 3 个并行 agent（链接 / 弯折点 / 文档间跳转）冻结 v2 契约。

## 1. v2 契约（后续 agent 据此实现）

### 1.1 版本号
- `CURRENT_DOC_VERSION = 2`（`model/constants.ts`）。

### 1.2 Edge.points（手动弯折点）
```ts
interface Edge {
  // ...原有字段不变（仍无 relation/line/direction）
  points?: Array<{ x: number; y: number }>;  // v2 新增
}
```
- 世界坐标，按 source→target 顺序；缺省 / undefined / 空数组 = 默认贝塞尔。
- zod：对象数组、x/y 必须有限数（NaN/Infinity 报错）、长度上限 64、未知键剥离。
- **类型偏差说明**：契约原文写 `ReadonlyArray`，但 core store 用 immer `WritableDraft`，
  readonly 数组不可分配给 draft，故实现为可变 `Array<{x,y}>`。语义不变。

### 1.3 DocRefLink（反链索引）+ Tiptap docRef mark
新文件 `model/links.ts`：
```ts
interface DocRefLink {
  id: string;            // ln_ 前缀 nanoid
  sourceDocId: string;   // 提及所在文档
  sourceNodeId: string;  // 提及所在块
  targetDocId: string;   // 可等于 sourceDocId（文档内提及）
  targetNodeId: string;
  targetTitle: string;   // 创建时标题快照，悬挂时展示
  createdAt: number;
}
```
- `KBNoteDoc.links: DocRefLink[]`（v2 必填，缺省 `[]`），与 `assetRefs` 同级。
- **core 不做内容抽取**：links 由 web 链接 agent 从 Tiptap 内容重建；迁移只补空字段。

Tiptap docRef mark 约定（供链接 agent）：
- mark name：`docRef`（常量 `DOCREF_MARK_NAME`）。
- attrs：`{ targetDocId, targetNodeId, targetTitle }`。
- 文本显示：`[[标题]]`（`DOCREF_WRAP = { start:'[[', end:']]' }`）。

## 2. 迁移注册表演进规则

- `MIGRATION_REGISTRY: Record<sourceVersion, (raw)=>unknown>`，key 为源版本。
- `migrate(raw, fromVersion)` 从 fromVersion 逐级升到 `CURRENT_DOC_VERSION`，缺步即抛
  `KBNoteFileError('unsupported-version')`；fromVersion===current 恒等。
- `MIGRATION_NOTES: Record<sourceVersion, string>` 给每步人类可读说明（migrationNotes 展示）。
- **以后每升一版**：在 `MIGRATION_REGISTRY` 注册 `n -> n+1` 纯函数，在 `MIGRATION_NOTES` 写一句说明，
  bump `CURRENT_DOC_VERSION`。迁移步必须纯数据转换，不做内容抽取 / IO。
- 当前：`MIGRATION_REGISTRY[1] = migrateV1ToV2`（version=2、links=[]、edges 原样保留），
  notes = `'v1→v2：新增 links/points 字段'`。

## 3. 备份与 FSA 门控策略

- **迁移只在内存发生**：parseKBNote 返回升级后的 doc，原文件不被改动，直到下一次写盘。
- **FSA 活动文件门控**：打开一个 v1 活动文件时，在用户确认前暂停对该文件的防抖写盘
  （Dexie 自动保存照常，本地不丢）：
  - `ui-store.migrationAwaitingConfirm: boolean` 记录待确认态。
  - `ActiveFileManager.setWritesBlocked(true/false)` 门控 `writeActiveFile`（blocked 时直接 resolve false，不写盘）。
  - 用户确认「保存时升级为 v2、覆盖原文件，建议先另存备份」后解除门控、恢复直写。
- 普通导入 / 新建路径不绑定活动句柄，不涉及覆盖原文件。
- **坏数据回滚**：迁移步或最终 schema 校验抛错时，parseKBNote 抛 `KBNoteFileError('schema')` /
  `KBNoteParseError`，调用方（importKbnote / dev hook）**不调用 loadDoc**，当前文档不变。

## 4. 高版本策略

- 文件 `version > CURRENT_DOC_VERSION` → 抛 `KBNoteFileError('unsupported-version')`。
- web 导入入口（`create-panels-api.importKbnote` / dev hook）捕获后弹 toast
  「文件版本更高，当前应用版本不支持打开」，**不替换当前文档**，不静默吞错。

## 5. 测试清单

core（`packages/core/src/**/*.test.ts`）：
- v1 样例（手工构造 version:1、无 links）migrate 后过 v2 schema、links=[]、points 缺省。
- 链式 v0→v1→v2（测试注册假步，验证顺序与注册表还原）。
- 坏数据（NaN point / 缺 createdAt 的 link / >64 points）回滚且不带入。
- v2 往返一致（键序 format/version 在前、links 保留）；高版本抛 unsupported-version。

web e2e（`e2e/schema-migration.spec.ts`）：
- 导入 v1 → version=2 且 migrationNotes 非空。
- 导入伪造 v9 → errorKind=unsupported-version，当前文档 id/version 不变。
