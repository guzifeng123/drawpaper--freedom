# Wave 9 · 同浏览器多标签实时协作（阶段 B：web 落地）

> 前置：阶段 A 已冻结 `packages/core/src/collab/` 纯协议（见 `collab-protocol.md`）。
> 本文记录阶段 B 在 `packages/web` 的传输 / UI / 接线实现、presence 协议参数、e2e 与已知边界。
> 铁律全程保持：**零服务器、零外网、不引入 yjs / 任何网络或 CRDT 库**；core 零 DOM/React。

## 1. 架构总览

```
┌─ packages/web/src/collab/ ────────────────────────────────────────┐
│ transport.ts        传输抽象：BroadcastChannel→storage→disabled   │
│ presence-peers.ts   远端 peer 表 + 心跳超时（纯函数）             │
│ doc-diff.ts         prev.doc→next.doc 差量 → CollabOp[]（纯函数） │
│ collab-ui-store.ts  zustand UI 态（peers/conflicts/身份）         │
│ collab-manager.ts   编排单例：身份/时钟/广播/合并/late-joiner     │
│ CollabBanner.tsx    冲突横幅 + 冲突列表 + 一键回滚快照            │
│ PresenceAvatars.tsx 顶部在线点（可改名）                          │
│ RemoteSelectionOverlay.tsx 远端选区/飞块只读装饰                   │
└───────────────────────────────────────────────────────────────────┘
```

### 1.1 通道命名与路由

| 通道 | 名字 | 载荷 |
|---|---|---|
| 站点级 | `drawpaper-collab:v1:site` | presence / snapshot-request / snapshot |
| 文档级 | `drawpaper-collab:v1:doc:<docId>` | op（高频，只路由给打开同一文档的标签） |

站点级通道承载低频消息：late-joiner 无需知道「谁打开了本文档」即可广播请求；
文档列表的「他标签打开」标记也靠 presence 信封里的 `docId` 推导。文档级通道把高频 op
隔离到只订阅本文档的标签，避免每个标签解析全部文档的 op。

### 1.2 传输与降级（`transport.ts`）

按优先级探测：

1. **BroadcastChannel**（同源同浏览器，首选）：`postMessage(JSON 信封)`，不回环给发送方。
2. **window `storage` 事件 + localStorage**（隐私模式 / 老浏览器无 BC）：每条消息独立键，接收方读后即删控制体积；`storage` 事件不发往当前文档，天然无回环。
3. **皆不可用 → disabled**：所有 send/onMessage 为 no-op，本标签独立编辑，不广播不收。

三者全部在浏览器进程内闭环，**不产生任何 http(s) 流量**。

### 1.3 命令管道接线（核心回环防护）

- **本地变更**：`editorStore.subscribe` 监听 `doc` 变化。非远端回写、非切文档时，
  用 `diffDocOps(prev.doc, next.doc)` 把命令管道产物差量成 op 序列；每条 op `clock.tick()`
  后填信封头 + `nextOpId()`，在文档级通道广播；再喂回本地 `applyOp` —— **只取元数据**
  （字段时钟 / vv / appliedOpIds / log），`doc` 仍以命令管道产物为准。
  差量法覆盖一切 action（addNode/paste/reparent/布局宏/setPage…），无需逐 action 埋点。
- **远端变更**：`parseEnvelope` 校验（坏消息 catch 丢弃，不污染状态）→
  `applyOp` → 仅当 `outcome==='applied'` 才经 core 新增 action `applyRemoteDoc(doc)` 落库
  （`duplicate/suppressed-tombstone/no-op` 跳过）。`applyRemoteDoc` 重置命令栈基线为远端 doc ——
  **远端 op 不进 undo 栈，本地撤销基线随远端合并整体重置**（有意取舍，见 §5）。
- **回环防护**：远端回写前 `applyingRemote++`，store 订阅见 `applyingRemote>0` 即跳过广播；
  自信封（`env.clientId === 本端 clientId`）一律忽略。

### 1.4 合并前快照

每次远端 `applied` 合并前（节流 ~2.5s）自动 `snapshotDoc('协作合并前')`。冲突横幅的
「回滚到合并前」恢复最近一条该标签快照。节流避免高频协作时快照爆炸。

### 1.5 late-joiner

打开文档即 `createCollabState(已落盘 doc)` → 在站点通道发 `snapshot-request`（带本端 vv）→
持方 `buildSnapshotResponse` 回基线 + baseVv + 本端未见过的增量 op → 请求方 `applySnapshot`
换基线、按 `(lamport,clientId)` 全序重放、opId 幂等跳过。全程无需刷新。
本端对每篇文档只对齐一次（`alignedForDoc` 守卫，避免后续 snapshot 覆盖本地新编辑）。

## 2. presence 协议参数

| 参数 | 值 | 说明 |
|---|---|---|
| 心跳发送间隔 | **1000ms** | presence 信封 `heartbeatSeq++` 广播 |
| 离线判定超时 | **3500ms** | `now - lastSeen > 3500` 即移除（含标签崩溃/关窗，无 goodbye） |
| 清扫周期 | 1000ms | 每 1s sweep 一次 peer 表 |
| 身份持久化 | sessionStorage | clientId 刷新前稳定；可编辑名称下次心跳广播；颜色按 seed 取 8 色调色板 |
| presence 载荷 | `{docId, selection[], hoverNodeId, blockRect, heartbeatSeq}` | 不进合并引擎、不写 doc |

- 在线点：顶部显示本文档远端 peer（颜色圆 + 名称），本端名称可点改。
- 远端选区：presence.selection 中的节点画对端颜色描边，hoverNodeId 半透明高亮；
  纯 `pointer-events-none` 装饰，不抢焦点、不进 60fps 关键路径。
- 文档列表：对「他标签正打开」的文档显示咨询性「他标签打开」徽标（**不加锁**，可同时编辑）。

## 3. e2e（`e2e/collab-multitab.spec.ts`，chromium 同 BrowserContext 两 page）

| # | 场景 | 断言 |
|---|---|---|
| ① | A 建块/连线/输入 → B 实时出现且 B 反向编辑 A 可见 | 节点数/内容双向收敛；零外网请求审计 |
| ② | A reparent/删边 → B 同步 | B 侧 parentId 与边数跟随 |
| ③ | late-joiner：A 落盘后 B 新开标签 | B 直接对齐到 A 的节点数，无刷新 |
| ④ | 并发改不同字段双方保留；并发 reparent | 内容+坐标共存；reparent 后节点仍在、至少一端冲突横幅非空 |
| ⑤ | A `page.close()` 异常关闭 | B 在心跳超时后 peerCount 归 0 |
| ⑥ | `addInitScript` 删 `BroadcastChannel` | transport 退化为 storage/disabled，单标签编辑正常 |

**零外网证据**：场景①在两个 page 上挂 `request` 监听，断言所有 `http(s)` 请求均为
`http://localhost`（dev server）。BroadcastChannel / localStorage 传输不产生任何网络请求。

## 4. 单测（web 纯函数化部分）

- `collab/transport.test.ts`：`detectTransportKind` 三态降级 + 通道命名。
- `collab/presence-peers.test.ts`：upsert / 超时清扫 / 超时窗口边界 / peersForDoc / docsOpenByPeers。
- `collab/doc-diff.test.ts`：增删改节点、reparent 的「删边+加边+parentId」原子差量、边补丁、标题/分页。
- core 侧新增 `applyRemoteDoc` 保持纯命令语义（重置栈基线 + 落盘）。

## 5. 已知边界

- **跨设备 / 云端不做**：仅同浏览器同源多标签；不引入 yjs/任何网络或 CRDT 库。
- **整体寄存器字段的并发取舍**：`tags / points / pageBreaks / selection` 按整体值 LWW，
  并发往 tags 加不同标签会互相覆盖而非并集（阶段 A 既定取舍）。
- **远端 op 不进 undo 栈**：远端合并会重置本地撤销栈基线；本地 undo 仅针对本地手势，
  合并后旧 undo 不可用（已在 UI 与文档明示）。
- **late-join 竞态**：对齐假设「新开标签对齐前无并发本地编辑」；对齐窗口内的本地编辑
  可能被到达的基线覆盖（实测 e2e 先对齐后编辑，不受影响）。
- **collab 元数据不落盘**：`createCollabState(loadedDoc)` 以 lamport=0 播种历史实体；
  长时间运行后靠 `compactCollabState` 周期性裁剪墓碑/opId 表，不随 doc 持久化。
- **tag 字典 / doc.layout / viewport 不广播**：节点上的 `tags` 数组会广播，但 `doc.tags`
  字典增删、布局模式、视口不进协作协议（视觉/会话态）。
