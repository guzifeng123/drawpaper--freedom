# Wave3-G · 文档生命周期 / 附件 / File System Access / 标签体系（store 接缝冻结）

> 范围（本分支唯一拥有）：`packages/core/src/store/`、`packages/web/src/storage/`、`packages/web/src/host/`、`packages/web/src/store/`。
> 本文是 Wave3 其他 P1 agent（面板 / 编辑器 / AI / 导出）与 Wave4 的接线圣经：**新 state / action 签名以本文为准**。
> 所有 doc 写操作仍走 Command（可撤销 / coalesce / 宏）；core 零 DOM，浏览器能力经 `StorageAdapter` / `FsaCapability` 注入。

---

## 1. 新增 EditorState 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `activeFile` | `{ name: string } \| null` | 活动本地文件名（标题栏「已保存到 xxx.kbnote」）。句柄本体在 web，不进 core。null = 纯 IndexedDB 自动保存。 |
| `manuallyMoved` | `Set<string>` | 手动移动过的块 id（UI 态）。`previewLayout` 作为 `manualFixed` 传入布局；`confirmLayout` 后清空。 |
| `focusNodeId` | `string \| null` | 当前聚焦分支块 id（工具栏 / 画布高亮联动）。 |
| `tagFilter` | `TagFilter` | 标签/类型/颜色筛选态（UI 态，不落 doc）。 |
| `backupEnabled` | `boolean` | 定时 JSON 备份开关（默认关；P1 由 web 按间隔提醒 + 下载）。 |

```ts
interface TagFilter { tagIds: string[]; types: BlockType[]; colors: string[]; match: 'any' | 'all' }
interface ManualPageBreak { id: string; x: number; y: number }
```

## 2. 新增 EditorActions 签名（冻结）

```ts
// ---- 标签 CRUD（doc.tags 为真相；全部可撤销）----
createTag(name: string, color: string): string
renameTag(id: string, name: string): void
setTagColor(id: string, color: string): void
deleteTag(id: string): void            // 宏：从 doc.tags + 所有 node.tags 级联移除，可撤销
setTagFilter(patch: Partial<TagFilter>): void
clearTagFilter(): void

// ---- 结构调整（大纲拖拽 / 边反转）----
reparentNode(nodeId: string, newParentId: string | null, index?: number): void
reverseEdge(edgeId: string): void

// ---- 手动分页符（写入 doc.page.pageBreaks，供导出 agent）----
addManualPageBreak(id: string, x: number, y: number): void
removePageBreak(id: string): void
setPageBreaks(breaks: ManualPageBreak[]): void

// ---- AI 建议（一条宏命令，整体一次 undo）----
applyAISuggestions(suggestions: ReadonlyArray<AISuggestion>, accepted: ReadonlySet<number>): void

// ---- 聚焦 ----
setFocusNode(id: string | null): void

// ---- 文档生命周期 ----
snapshotDoc(label?: string): Promise<void>
listSnapshots(docId: string): Promise<SnapshotMeta[]>
restoreSnapshot(id: string): Promise<void>     // 恢复本身是一条可撤销/可再恢复命令
listTrash(): Promise<TrashDocMeta[]>
restoreTrash(id: string): Promise<void>
purgeTrash(id: string): Promise<void>
emptyTrash(): Promise<void>
createDocFromTemplate(templateId: string): void
setBackupEnabled(on: boolean): void

// ---- File System Access 活动文件 ----
openLocalFile(): Promise<void>
saveLocalFileAs(): Promise<void>
clearActiveFile(): void

// ---- 附件（OPFS）----
putImageAsset(blob: BlobLike): Promise<{ src: string; assetRef?: string }>
```

### 2.1 StoreDeps 新增注入项

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `fsa` | `FsaCapability` | 无 | File System Access 能力（web 注入）；缺省则纯 Dexie 自动保存。 |
| `templates` | `Record<string, TemplateFactory>` | 无 | 模板 id → 工厂；`createDocFromTemplate` 按 id 取用。 |

```ts
interface FsaCapability {
  isSupported(): boolean;
  pickLocalFile(): Promise<{ name: string; text: string } | null>;
  writeActiveFile(text: string): Promise<boolean>;   // web 内部 500ms 防抖写句柄
  saveFileAs(suggestedName: string, text: string): Promise<string | null>;
}
type TemplateFactory = () => KBNoteDoc;
```

### 2.2 StorageAdapter 新增（全部可选；缺省对应 action 安全降级 no-op）

```ts
saveSnapshot?(docId, label: string|null, text: string): Promise<SnapshotMeta>
listSnapshots?(docId): Promise<SnapshotMeta[]>
getSnapshot?(id): Promise<SnapshotRecord|null>
deleteSnapshot?(id): Promise<void>
listTrash?(): Promise<TrashDocMeta[]>
restoreFromTrash?(id): Promise<void>
purgeTrash?(id): Promise<void>
emptyTrash?(): Promise<void>
```
> `deleteDoc` 语义升级为「移入回收站」：Dexie 把整份 doc 拷入 `trash` 表并打 `trashedAt`，不物理删除、不清附件；只有 `purgeTrash / emptyTrash` 才物理删除并清理 `assetRefs` 指向的 OPFS Blob。

---

## 3. AISuggestion（core/adapters.ts，已扩展）

```ts
interface AISuggestion {
  type: 'add-edge' | 'set-root' | 'group' | 'split-block' | 'summarize';
  nodeIds?: string[];
  proposedEdges?: Array<{ source: string; target: string; label?: string }>;
  text?: string;       // split-block / summarize 的段落文本；group 的标题
  title?: string;      // group 容器块标题
  afterNodeId?: string;// split-block：在其后建兄弟块（缺省 nodeIds[0]）
  reason: string;
}
```

`applyAISuggestions` 对 `accepted` 命中的建议逐条变换，**未勾选丢弃**；函数内做幂等/合法性保护：
- `add-edge`：端点不存在 / 自环 / 同 pair 已存在 → 跳过。
- `set-root`：不改结构（根由布局按入边推导），仅占位。
- `group`：新建 group 块（取成员包围中心），把成员 `parentId` 指向它并补 group→成员边。
- `split-block`：在 `afterNodeId` 之后新建文本兄弟块（内容 = `text` 段落）。
- `summarize`：把目标块内容替换为 `text` 段落（undo 还原原 content）。

---

## 4. 时序

### 4.1 自动快照
```
switchDoc(打开/新建/导入)
 ├─ takeSnapshot()                 # 拍一条基线（label=null）
 └─ armAutoSnapshot(): setTimeout(5min)
      └─ 触发时若 snapshotDirty → takeSnapshot() → 再 arm
任意 doc 写动作(runCommand/runMacro) → snapshotDirty=true
snapshotDoc(label?) → storage.saveSnapshot(docId,label,serializeKBNote(doc))
restoreSnapshot(id)  → getSnapshot → parseKBNote → runCommand('restore-snapshot')
                       execute=restoredDoc, undo=beforeDoc（可撤销/可再恢复）
```
- 保留策略：每文档最近 `SNAPSHOT_KEEP = 20` 条，超出淘汰最旧（`pruneSnapshotsToLatest` 纯函数，Dexie 与 node 内存桩共用）。
- 仅当 `storage.saveSnapshot` 存在时启动定时器；node 测试桩不带该方法则不启动。

### 4.2 自动保存 + FSA 双写
```
任意 doc 写 → scheduleAutosave(): dirty=true; 500ms 防抖
 └─ flushSave():
      saveState=saving → await storage.saveDoc(doc)          # Dexie 主写
      if activeFile && deps.fsa → await fsa.writeActiveFile(serializeKBNote(doc))  # 文件双写(web 再防抖 500ms)
      成功 → saveState=saved, savedAt=now, dirty=false
openLocalFile() → fsa.pickLocalFile() → importKBNoteText(text) → activeFile={name}
saveLocalFileAs() → exportKBNoteText → fsa.saveFileAs(title+'.kbnote', text) → activeFile={name}
```

### 4.3 附件
```
粘贴/选图(web) → compressImageBlob(file)   # canvas 解码, 长边>1600 等比缩, webp q0.8
 → store.putImageAsset(blob) → storage.putAsset → assetRef
 → runCommand('register-asset') 把 assetRef 追加进 doc.assetRefs
渲染时 getAssetUrl(assetRef) → URL.createObjectURL(Blob)（缓存）
删除文档: trash 不清附件; purgeTrash/emptyTrash → deleteAsset(ref) 逐个清理
OPFS 不可用: compress/putAsset 抛 OpfsUnavailableError → web 降级 dataURL 内嵌（addImageBlock(dataUrl)）
```

### 4.4 分页符持久化形状
`doc.page.pageBreaks` 的 model/zod 持久化形状为 `{ at: number }`。store 契约 `ManualPageBreak{id,x,y}` 在写入时补 `at`（纵向取 y、横向取 x）：
```ts
{ at: (orientation==='landscape' ? x : y), id, x, y }
```
内存会话内按 `id` 增删；经序列化再 parse 后 zod 剥离 id/x/y，规整为 `{ at }`（位置仍保留，供导出 agent 读 `at`）。

---

## 5. 降级矩阵

| 能力 | 首选 | 降级 | 实现 |
|---|---|---|---|
| 文档持久化 | Dexie `docs` 表整 doc | —（P0 必选） | `storage/db.ts` |
| 历史快照 | Dexie `snapshots` 表（每文档 20 条） | 缺 `saveSnapshot` → 动作 no-op | `storage/db.ts` + `store.snapshotDoc` |
| 删除 | 移入 `trash` 表（可恢复） | 缺 trash 方法 → no-op | `storage/db.ts` |
| 大附件 | OPFS `drawpaper-assets/` + canvas 压缩 | `OpfsUnavailableError` → dataURL 内嵌 | `storage/opfs.ts` |
| 打开本地文件 | File System Access `showOpenFilePicker`（句柄存 Dexie） | 动态 `<input type=file>` | `storage/fsa.ts` + `host/web-host.ts` |
| 保存本地文件 | `showSaveFilePicker` / 活动句柄防抖写 | Blob + `<a download>` | 同上 |
| 定时备份 | P1 = 提醒 + 下载（`backupEnabled` 开关） | 默认关；web 未接线定时器 | `store.setBackupEnabled` |
| 全文搜索 | MiniSearch | — | `storage/search-index.ts`（既有） |

---

## 6. 模板清单（`web/src/storage/templates.ts`）

| id | 名称 | 结构 |
|---|---|---|
| `reading-notes` | 读书笔记 | 根标题 → 核心观点(列表) / 摘录便签 / 我的思考 / 行动待办 |
| `meeting-notes` | 会议纪要 | 根标题 → 参会人/目标 / 决议事项(待办) / 待办 / 下次跟进 |
| `course-outline` | 课程大纲 | 根标题 → 三章(heading) × 三小节(text) |
| `brainstorm` | 头脑风暴 | 根标题 → 4 个自由想法 + 后续便签 |
| `knowledge-system` | 知识体系 | 根标题 → 两分支(heading) × 三概念(列表) |
| `project-breakdown` | 项目拆解 | 根标题 → 三阶段(heading) × 两任务(待办) |

每份均用 core factory 建块 + 父子边 + 标题/待办/列表/便签块型，产出 doc 经 `safeParseKBNoteDoc` 校验通过，6 份 id 互不相同。`createDocFromTemplate(id)` 切换过去。

---

## 7. 测试（本分支）

- core：91（81 既有 + 10 新 `wave3.store.test.ts`）——快照淘汰 21→20、restore 可撤销、标签 CRUD/级联/撤销、reparent 边结构+parentId+成环防护、reverseEdge、pageBreaks、applyAISuggestions 五类变换+未勾选丢弃+幂等、manuallyMoved 标记与 `manualFixed` 传参。
- web：82（75 既有 + 7 新）——模板 6 份过 parseKBNoteDoc 且 id 不同、computeResize 尺寸决策、FSA 不支持时降级。
