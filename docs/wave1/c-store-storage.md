# Wave1-C · 应用状态内核与浏览器存储适配

> 范围：`packages/core/src/store/`、`packages/web/src/storage/`、`packages/web/src/host/`、`packages/web/src/store/`。
> 本文是 Wave2 / UI agent 的「接线圣经」：最终 EditorStore 全量签名、依赖注入、冲突与自动保存时序、存储降级矩阵。

## 1. 架构一句话

```
UI(web) ──hooks──▶ EditorStore(zustand vanilla + immer)
                       │  所有 doc 写操作 = Command ──▶ CommandStack(undo/redo/coalesce/macro)
                       │  deps.storage 防抖 500ms ──▶ Dexie/IndexedDB
                       │  deps.analyzer / layoutEngine（默认绑 graph/layout，测试可注入桩）
                       └─ deps.resolveConflictUi（web 弹窗）
```

- core 零 DOM：浏览器能力（IndexedDB / OPFS / FSA / window / navigator）全部在 web 侧，经 `StorageAdapter` / `HostAdapter` 注入。
- `createEditorStore(init, deps)` 返回 **zustand vanilla `StoreApi<EditorStore>`**（`EditorStoreApi`），不是裸对象；web 用 `useStore` 接线。

## 2. StoreDeps（注入项）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `storage` | `StorageAdapter` | 无（不自动保存） | 注入后启用 500ms 防抖自动保存 + open/delete/listDocs |
| `host` | `unknown` | 无 | 预留；store 不直接调用，web 自持有 `WebHostAdapter` |
| `now` | `() => number` | `Date.now()` | 时钟注入（测试用假时钟 / 假时间戳） |
| `analyzer` | `(nodes, edges) => {multiParents, cycles}` | `graph.detectConflicts` | 冲突检测；单测注入桩，不依赖未合并的 graph 实现 |
| `layoutEngine` | `(input, mode) => {positions,...}` | `layout.layoutTree` | 布局引擎；单测注入桩返回固定位置 |
| `resolveConflictUi` | `(pending) => Promise<ConflictResolution \| null>` | 无（不弹窗，冲突只挂起） | web 注入弹窗；resolve=裁决，null=取消回滚 |

## 3. EditorState 全量字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `doc` | `KBNoteDoc` | 当前文档（唯一 doc 真相） |
| `currentDocId` | `string` | = doc.id |
| `docs` | `DocMeta[]` | storage 文档列表（updatedAt 倒序） |
| `selection` | `Set<string>` | 选中节点 |
| `edgeSelection` | `Set<string>` | 选中边 |
| `editingNodeId` | `string \| null` | 块内 Tiptap 编辑中 |
| `mode` | `InteractionMode` | select/connect/pan/box-select/insert |
| `viewport` | `Viewport` | {x,y,zoom} |
| `canUndo` / `canRedo` | `boolean` | 命令栈派生 |
| `pendingConflicts` | `PendingConflicts \| null` | 待裁决多父/成环负载 |
| `layoutUi.scopeSelected` | `boolean` | 仅整理选中分支（预留） |
| `measuredSizes` | `Record<id,{width,height}>` | web ResizeObserver 实测 |
| `layoutPreview` | `Record<id,{x,y}> \| null` | 预览位置（不落 doc） |
| `searchIndex` | `unknown` | MiniSearch 不透明句柄 |
| `searchQuery` / `searchResults` | `string` / `{nodeId,snippet}[]` | 搜索 |
| `searchHighlight` | `Set<string>` | 高亮节点 |
| `clipboard` | `{nodes,edges} \| null` | 内部剪贴板（深拷贝） |
| `prefs` | `{showGrid, snapToGrid}` | 画布偏好 |
| `dirty` | `boolean` | 相对上次保存有改动 |
| `saveState` | `'idle'\|'saving'\|'saved'` | 自动保存状态机 |
| `savedAt` | `number \| null` | 上次保存时间戳 |
| `lastFocus` | `{nodeId, nonce} \| null` | flyTo 目标（nonce++ 触发动画） |

## 4. EditorActions 全量签名

```
// 文档级
newDoc(): void
renameDoc(title: string): void
loadDoc(doc: KBNoteDoc): void
duplicateDoc(): Promise<void>
openDoc(id: string): Promise<void>
listDocs(): Promise<void>
deleteDoc(id: string): Promise<void>

// 节点 CRUD（全部走 Command）
addNode(type: BlockType, x, y): string
addNodes(nodes: BlockNode[]): void
deleteNode(id: string): void            // 级联删出入边
deleteNodes(ids: string[]): void
updateContent(id, data): void           // coalesceKey `content:${id}`
moveNode(id, x, y): void                // coalesceKey `move`
resizeNode(id, w, h): void              // coalesceKey `resize`
updateNodeStyle(id, patch: Partial<BlockStyle>): void

// 边（仅父子一种语义）
addEdge(source, target, opts?: {label?, color?, sourceHandle?, targetHandle?}): void
deleteEdge(id): void
setEdgeColor(id, color): void
setEdgeLabel(id, label): void

// 导图键盘
tabAddChild(): void          // 选中/编辑节点下建子块 + 父子边
enterAddSibling(): void      // 同父兄弟
shiftTabDemote(): void       // 挂到祖父；无祖父则退化为根

// 几何（宏）
alignSelection(mode: 'left'|'hcenter'|'right'|'top'|'vcenter'|'bottom'): void
distributeSelection(axis: 'horizontal'|'vertical'): void

// 布局
applyLayout(): void          // = previewLayout() 后立即 confirmLayout()
previewLayout(): void        // measuredSizes+engine → layoutPreview，不落 doc
confirmLayout(): void        // 预览位置作为一条宏落 doc，单次 undo 整体回退
cancelLayout(): void
setLayoutMode(mode): void
setSpacing(rank, node): void
toggleScopeSelected(): void

// 块属性
togglePin / toggleCollapse / toggleTodo(id): void
addTagToNode(nodeId, tagId) / removeTagFromNode(nodeId, tagId): void

// 页面 / 测量
setPageSettings(patch: Partial<PageSettings>): void
setPageOrigin({x,y}): void
setMeasuredSizes(map: Record<id, MeasuredSize>): void

// 搜索
setSearchQuery(q) / setSearchResults(results) / clearSearchHighlight() / setSearchIndex(handle): void

// 选择 / 模式
setSelection(ids) / setEdgeSelection(ids) / setMode(m) / setEditingNode(id) / setViewport(vp): void

// 剪贴板（深拷贝 + nanoid 重映射 + 24px 偏移）
copy() / cut() / paste() / duplicate(): void

// 撤销重做
undo() / redo(): void

// 冲突
resolveConflicts(resolution: ConflictResolution): void

// 导入导出 / 保存 / 导航
exportKBNoteText(): string
importKBNoteText(json: string): void
requestSave(): void          // 不等防抖窗口立即落盘
flyToNode(nodeId): void      // 仅写 lastFocus

// 状态
setSaveState(s) / setPrefs(patch): void
```

## 5. CommandStack 合并语义

- `push` 执行并入 undo 栈、清 redo。
- **coalesce**：相邻命令 `coalesceKey` 相同且 `now()-pushedAt ≤ 800ms` → 复合为一条（`execute=next∘top`，`undo=top∘next`），一次 undo 回退整个手势（拖拽 / 连续打字）。
- `executeMacro(name, cmds)`：顺序执行、逆序回退，占一个 undo 单元（一键整理、对齐、裁决删边）。
- 时钟/窗口可注入（`createCommandStack(init, { now, coalesceWindowMs })`）。

## 6. 冲突时序（addEdge 触发）

```
addEdge(s,t)
 ├─ depthBefore = stack.depth().undo
 ├─ runCommand(add-edge)                 # doc 已含新边
 └─ promptConflicts([edgeId], depthBefore)
      ├─ analyze(nodes,edges) → 多父?成环?
      │   无 → return
      ├─ set pendingConflicts
      └─ await deps.resolveConflictUi(pending)
           ├─ resolve(裁决) → applyResolution:
           │    choosePrimaryParent → 保留主父边，其余入边 deleteEdge(宏)
           │    breakEdgeIds → 成环删边
           │    runMacro('resolve-conflicts')，清 pending
           └─ null(取消) → while depth>depthBefore: stack.undo()  # 精确回滚本次触发
```
全程一条可撤销历史；删除多余边是宏，undo 可整体恢复。

## 7. 自动保存时序（deps.storage 存在时）

```
任意 doc 写操作
 └─ scheduleAutosave(): dirty=true; clearTimeout; setTimeout(500ms)
      └─ flushSave():
           saveState='saving' → await storage.saveDoc(doc)
           成功 → saveState='saved', savedAt=now(), dirty=false
           失败 → saveState='idle'（保留 dirty，下次重试）
```
500ms 内连续编辑只落盘一次；`requestSave()` 立即 flush（卸载/导出前调用）。

## 8. 存储降级矩阵

| 能力 | 首选 | 降级 | 实现 |
|---|---|---|---|
| 文档持久化 | Dexie/IndexedDB（`docs` 表整 doc JSON，updatedAt 倒序列表） | —（P0 必选） | `web/src/storage/db.ts` `DexieStorageAdapter` |
| 大附件 Blob | OPFS（`drawpaper-assets/` 目录） | 抛 `OpfsUnavailableError`，上层降级 | `web/src/storage/opfs.ts` |
| 打开 .kbnote | File System Access `showOpenFilePicker` | 动态 `<input type=file accept=.kbnote>` | `web/src/host/web-host.ts` + `fsa.ts` |
| 保存 .kbnote | File System Access `showSaveFilePicker` | Blob + `<a download>` | 同上 |
| 打印 | `window.print()` | — | `WebHostAdapter.print()` |
| 分享 | `navigator.share` | 静默忽略 | `WebHostAdapter.share()` |
| 全文搜索 | MiniSearch（字段=节点纯文本；doc 变更 300ms 防抖全量重建） | — | `web/src/storage/search-index.ts` |

## 9. web React 接线（`web/src/store/`）

- `editor-store.ts`：单例 `createEditorStore(blankDoc, { storage: DexieStorageAdapter, host: WebHostAdapter })`；bootstrap 时 `listDocs → openDoc(recent) 或 newDoc`；订阅 doc 变更 300ms 防抖重建 MiniSearch。
- `index.tsx`：
  - `useEditorStore<T>(selector, equalityFn?)` — 通用选择器
  - `useActions()` — 稳定 actions 句柄
  - `useSaveStatus()` — `{saveState, savedAt}`
  - `useDocs()` — 文档列表
- 不修改 `App.tsx`；hooks 自类型正确、可被 Wave2 import。

## 10. 测试清单

core（node vitest，20 例）：
- command 栈：push/undo/redo、清 redo、macro 单 undo、窗口内 coalesce、超窗不合、异 key 不合（6）。
- store：add/delete 级联删边；move/resize/content coalesce 与 undo；Tab/Enter/Shift+Tab 边结构；多父裁决删边且可撤销；取消回滚；成环断边；preview→confirm 宏单次 undo；自动保存 500ms 只落一次 + savedAt；paste id 重映射无旧引用；import/export 往返（10 + smoke 4）。

web（jsdom，6 例）：extractPlainText（段落/嵌套标题·列表·待办/空）；MiniSearch build+search 命中与 snippet；空查询空结果。
