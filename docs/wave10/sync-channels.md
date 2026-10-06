# Wave 10 阶段 B — 跨设备同步通道（FSA 同步文件夹 + 手写 WebDAV）

阶段 A 已冻结 `packages/core/src/sync/` 合并内核（Lamport 全序 / 字段级 LWW / 墓碑 / `mergeSnapshots` / 清单与游标）。阶段 B 在 `packages/web` 接入两类**用户自有、零托管**的传输通道，把内核接到真实落盘与网络：

- **FSA 同步文件夹**：`showDirectoryPicker()` 选一个本地目录，`.kbnote` 与资产按内容落进去，配合轮询 / `visibilitychange` 检测外部改动（Syncthing / 网盘 / U 盘同步的自然落点）。
- **WebDAV**：手写 `fetch` + `DOMParser` 解析 PROPFIND，零新依赖，凭据仅存 localStorage。

红线全程遵守：**不引入 yjs / webdav / XML 库 / 任何托管服务**；未配置通道时**默认零外网**；两通道互斥。

---

## 1. 架构总览

```
                         ┌──────────────────────────── packages/web ───────────────────────────┐
                         │                                                                       │
  本地编辑 (editorStore) │   ┌──────────────┐   stampForPersist   ┌──────────────────────┐        │
  addNode/updateContent ├─▶ │ DexieStorage  │ ───────────────────▶ │ 盖章层 stamper.ts      │        │
  /deleteNode/setPage …  │   │ Adapter.save │   落盘边界盖章      │  clientId+递增 lamport │        │
                         │   └──────┬───────◀─────────────────── └──────────────────────┘        │
                         │          │ db.docs.put (v3 落盘戳)                                      │
                         │          ▼                                                              │
                         │   ┌──────────────────────── sync-controller.ts（生命周期/互斥/定时器）──┐  │
                         │   │  folder 通道 ─┐            ┌─ webdav 通道（手动+可选定时）       │  │
                         │   └───────────────┼────────────┼────────────────────────────────────┘  │
                         │                   ▼          ▼                                          │
                         │            ┌──────────────────────── orchestrator.runSync ────────────┐ │
                         │            │  flush → localManifest ⇄ remoteManifest → planBundle      │ │
                         │            │  → push/pull/merge：合并前 snapshotDoc('同步合并前')        │ │
                         │            │  → mergeSnapshots(local, remote, base) → applyRemoteDoc    │ │
                         │            │  → 冲突写 .conflicted-<t>.kbnote → advance cursor/base    │ │
                         │            └───────────────────────────────────────────────────────────┘ │
                         │                   ▲                                          ▲        │
                         │       sync-db.ts (Dexie 'drawpaper-sync': syncBase / syncState)│        │
                         └───────────────────│──────────────────────────────────────────│────────┘
                                             │                                          │
                          ┌──────────────────┴─────────┐              ┌─────────────────┴───────────┐
                          │ FSA 通道 fsaChannel.ts      │              │ WebDAV 通道 webdavChannel.ts │
                          │ DirectoryHandle 抽象        │              │ WebDavClient (手写 fetch)    │
                          │ 真实: showDirectoryPicker    │              │ PROPFIND/GET/PUT, DOMParser  │
                          │ fake: e2dev-hook 注入内存树 │              │ 凭据 localStorage, 401 分类 │
                          └──────────────────────────────┘              └─────────────────────────────┘
```

## 2. 盖章层（stamper.ts）——v3 落盘接线

内核冻结契约 §5.4：**本地每处编辑必须把真实 clientId + 递增 lamport 写进 `doc.sync.vv` 与对应字段的 `f` 戳**。本阶段不改 core 命令语义，而是在 web 落盘边界做「命令后差量盖章」。

- **设备 clientId 持久化**：`device-identity.ts` 从 localStorage（`d_` 前缀，区别于 Wave9 多标签 sessionStorage 的 `c_`）读取 / `seedClientIdFor` 生成。
- **落盘边界盖章**：包装 `DexieStorageAdapter.saveDoc`，把本端 `[lamport, clientId]` overlay 到即将落盘的 doc。复用 Wave9 `collab/doc-diff.ts` 的差量模式比对前后 doc，累加器按 docId 单调增长、整体 overlay，幂等不丢历史戳。
- **加载抬钟**：打开 v3 文档后 `adoptClockFloor(doc)` / `maxPersistedLamport(doc)` 把本端时钟抬到 floor 再 tick，保证本端时间戳不回退。
- **不盖章的路径**：远端合并期间（`applyingRemote` 计数）与文档切换（`currentDocId` 变化）不盖章，避免把远端历史再盖成本端。

盖章覆盖矩阵（全部走 saveDoc 边界，故天然覆盖）：

| 变更路径 | 时钟化字段 | 落盘位置 |
|---|---|---|
| 建块 / 删块 | 新块 `nodes[id]`；删除写 `t` 墓碑 | `sync.nodes[id]` |
| 编辑块内容 | `content` | `sync.nodes[id].f.content` |
| 移动 / reparent | `x,y,width,height,parentId` | `sync.nodes[id].f.*` |
| 边增删改（含 points/color） | 边字段集 | `sync.edges[id].f.*` |
| 文档改名 | `title` | `sync.docF.title` |
| 分页设置 | `page.*` | `sync.pageF.*` |
| 上述任一字段发生时 | 版本向量 | `sync.vv[clientId] = max(…)+1` |

## 3. DirectoryHandle 抽象（directory-handle.ts）

Playwright 无法真实操作 `showDirectoryPicker` 的目录选择 UI，故把通道依赖收敛到一个最小接口，生产用真实 FSA、e2e 用内存 fake 走**同一份**导出 / 检测 / 合并代码路径：

```ts
interface SyncDirectoryHandle {
  list(): Promise<Array<{ name: string; kind: 'file' | 'dir' }>>;
  readFile(name: string): Promise<string | null>;
  writeFile(name: string, contents: string): Promise<void>;
}
```

- 生产实现包 `showDirectoryPicker()`；`isFsaDirectorySupported()` 探测，不支持时 UI 降级提示手动上传 / 下载。
- e2e 经 `dev-hooks.ts` 的 `syncUseFakeFolder()` 注入 `FakeDirectoryHandle`（页面内 Map 文件树）；`syncFakeWrite` 模拟对端 / Syncthing 落盘，`syncFakeDump` 断言目录内容。

## 4. base / cursor 持久化（sync-db.ts）

三路合并需要「上次同步点」作为 base 来消除假冲突。为不污染 `.kbnote` 本体，独立开一个 Dexie 库 `drawpaper-sync`：

- 表 `syncBase`：每文档上次收敛点的序列化文本（`manifestFromDoc` 产出的 manifest + doc 文本）。
- 表 `syncState`：单例，存 `SyncCursor`（`emptyCursor` / `advanceWatermark` / `mergeCursors`）与推 / 拉计数。

合并时把 `readBase(docId)` 作为第三参传给 `mergeSnapshots(local, remote, base)`；合并成功后 `writeBase(docId, merged)` 推进。

## 5. 编排（orchestrator.runSync）

统一流程，两通道共用：

1. `requestSave` 落本地待存；
2. `localManifest = manifestFromDoc`，`remoteManifest = channel.listRemoteDocs → pullDoc`；
3. `planBundle(local, remote)` 得 `pushDocIds / pullDocIds / mergeDocIds / missingAssets`；
4. 对每个待合并文档：**先 `snapshotDoc('同步合并前')` 自动拍快照**（与协作一致）→ `mergeSnapshots(local, remote, base)` → 打开中的文档走 `applyRemoteDoc`（重置命令栈基线、不进 undo），非打开文档直接 `db.docs.put`；
5. `conflicts.length > 0` 时把 remote 副本写成 `《文档名》.conflicted-<ISO时间>.kbnote` 到同步目录，并弹 `SyncBanner`（复用 Wave9 CollabBanner 形状 + `summary` 中文摘要）；
6. `advanceWatermark` / `writeBase` 推进游标与 base。

## 6. WebDAV 兼容注意（webdav.ts）

- **手写，零依赖**：`fetch` + `DOMParser`（`application/xml`）解析 PROPFIND 207。
- **命名空间无关解析**：真实服务器返回的是 `<d:multistatus>/<d:response>/<d:href>`（带 `DAV:` 命名空间前缀），必须用 `getElementsByTagNameNS('*', 'response'/'href'/'collection')` 匹配；早期用 `getElementsByTagName('response')` 在 Chromium 上漏解析，导致远端清单为空、永远不拉取——已修并加单测。
- **href 剥离**：PROPFIND 的 href 通常是服务器根相对路径（`/dav/drawpaper/a.kbnote`），按 baseUrl 的 **pathname**（不含 host）剥离。
- **错误分类**：401/403 → `WebDavError('auth')`（toast「认证失败，请检查用户名/密码」）；网络异常 → `WebDavError('network')`（toast「无法连接服务器」）；均不丢本地数据。
- **http 明文**：UI 检测 `http://` 弹红色警告；定时轮询默认关、下限 `MIN_WEBDAV_POLL_MS = 5min`。

## 7. 冲突副本流程

```
外部写入 docX.kbnote（对端并发改同字段）
        │
  runSync pull → mergeSnapshots(local, remote, base)
        │  conflicts.length > 0 ?
        ├─ 否：快进落库，advance cursor
        └─ 是：
             ① snapshotDoc('同步合并前') 已拍快照（可回滚）
             ② applyRemoteDoc(merged) 落库（墓碑胜，败方记录）
             ③ 把 remote 副本写为「docX.conflicted-<ISO>.kbnote」到同步目录
             ④ SyncBanner 顶部列出 summary 中文摘要，关闭即已知悉
```

## 8. 隐私与零外网

- 未配置任何通道时：**零 http(s) 请求**。`BroadcastChannel` / `storage` / `blob` / IndexedDB 都不算网络。
- WebDAV 仅在用户显式填地址 + 「连接」后发请求；凭据只写 localStorage（与 AI key 同级）。
- 两通道互斥：UI 单选，同时只启用一个；「停止同步并清除凭据」清掉配置与定时器。
- FSA 通道数据只写用户选的本地目录，不经任何官方服务器。

## 9. e2e 证据（四类）

| # | 用例 | 断言 |
|---|---|---|
| ① | WebDAV route mock：Node 侧模块级 Map 共享服务器，两个 BrowserContext = 两设备 | A 推 → B 拉合并（openDoc 后看到 A 的块）→ B 改 → A 拉，双向收敛；全程审计零未授权外网 |
| ② | FSA fake directory handle | 自动导出 `.kbnote`；`syncFakeWrite` 模拟外部落盘被轮询拉取；并发冲突生成 `*.conflicted-<时间>.kbnote` |
| ③ | 未配置通道断网请求审计 | 建块 / 改内容期间 `EXTERNAL === []`（离线 zero-extranet 不回退） |
| ④ | 同一 v2 档两端升级 v3 | `v3MigrationCheck`：`ok / version=3 / migratedDeepEqual / mergedConflictCount=0`（0 假冲突） |

## 10. 遗留

- 墓碑 watermark 尚未做有界化（长期高频删除下 `vv` / 墓碑表增长，后续阶段裁剪）。
- 资产仍是 nanoid 引用、**非内容寻址 hash**（传输层做了按 hash 去重，但 assetRef 本体未切内容寻址）。
- Safari / Firefox 无 FSA 时的手动上传 / 下载降级仅做了提示文案与纯函数部分，完整打包上传 UI 待补。
