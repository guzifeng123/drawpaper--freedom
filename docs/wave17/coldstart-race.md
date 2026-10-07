# Wave17 J2 — Windows 冷启动外部文件打开事件竞态（cold-start open-file race）

分支：`feat/desktop-coldstart-race`（基线 `3451c37` = rc.8）。
范围：**仅 Rust**（`apps/desktop-tauri/src-tauri/`）+ `release-windows.yml` 新增一条 x64 冒烟 + 本文档。
**不碰** web 业务源码、版本号、tag、Cargo.toml、tauri.conf.json、既有 CI 步骤。

---

## 1. 问题陈述

进程未运行时，用户双击 `.kbnote`（或命令行以文件路径启动），首个实例必须 100% 消费该文件：
不丢事件、不竞态、不重复加载。

现状（rc.8）：冷启动时 Rust 在 `setup` 回调里 `maybe_seed_startup_file` →
`open_external_path` **一次性 fire-and-forget** `app:open-file`。该 emit 发生在
webview 页面加载完成、前端 React 挂载并注册监听**之前**，事件被 Tauri 事件总线直接丢弃
（Tauri 2 对「无监听者时 emit」不做任何缓冲/重放）。结果：日志/recents 证明 Rust 收到了
argv[1]，但 webview 画布实际并没有加载该文档——用户看到的是欢迎文档，不是刚双击的文件。

热启动（单实例第二实例回调）路径**没有**这个问题：此时 webview 早已加载、监听早已注册，
emit 立刻被消费。

---

## 2. 启动时序审计（逐环节画时间线）

以下行号基于 `apps/desktop-tauri/src-tauri/src/lib.rs` @ `3451c37`。

```
T0  进程入口 main() -> run()
T1  --diag-export CLI 拦截（lib.rs:920-928）
        └─ 在构建任何 Tauri 插件（含 single-instance）之前。命中则直接 exit，
           不弹窗、不开 webview、不进主循环。本竞态与之无关。
T2  portable 路径重定向（lib.rs:941-958，portable.rs）
        └─ current_exe_dir() 探测 -> decide_portable() 纯函数。命中则在
           context.config_mut() 上设 app_directories_override::Root(<exe>/data)。
           发生在 tauri::Builder 构建之前；之后所有 path() 调用自动跟随。
           本竞态与之正交（重定向只影响数据落盘位置，不影响事件时序）。
T3  tauri::Builder::default()（lib.rs:960）
T4  single-instance 插件注册（lib.rs:963-976）——第一个插件
        └─ 第二个实例起来后在自己进程内直接 exit，把 argv 回调给首个实例。
           首个实例此处注册的回调就是「热启动」入口。
T5  其余插件（log / window-state / dialog / fs / opener / notification / updater）
T6  .manage(AppState::default())（lib.rs:1001）
T7  .setup(|app| { ... })（lib.rs:1002-1119）
        7a. load_recents 填入 state.recents
        7b. maybe_seed_startup_file(&app.handle())（lib.rs:1012）
              └─ std::env::args() 取 argv[1] -> open_external_path(app, path)
                 ├─ 校验 .kbnote 扩展
                 ├─ fs::read_to_string 读全文
                 ├─ state.current_path = Some(path)
                 ├─ push_recent（写 drawpaper-recents.json + 重建菜单）
                 ├─ log::info!("open-file (external): ...")   ← 冒烟断言的就是这一行
                 └─ app.emit("app:open-file", {path,name,text,external:true})
                    ★★★ 这里就是 fire-and-forget 丢点 ★★★
        7c. build_menu / set_menu / on_menu_event
T8  on_window_event（close-guard）/ invoke_handler（命令注册）
T9  .run(context) —— 进入事件循环，此时 webview 窗口才开始加载前端 HTML/JS
T10 前端 webview 加载完成（did-finish-load）—— 远晚于 T7b
T11 前端 JS bundle 执行 -> React 根挂载
T12 App.tsx useEffect([]) 调 initDesktopBridge()（packages/web/src/App.tsx:161-163）
T13 new TauriHostAdapter()（同步）
T14 a.onOpenFileEvent(handler) —— 内部是 window.__TAURI__.event.listen('app:open-file', ...)
    这是一个 Promise（desktop-bridge.ts:204），resolve 后才真正挂上监听。
```

### 2.1 前端监听注册时机（读 packages/web 源码确认，只读不改）

- `packages/web/src/host/desktop-bridge.ts:162` `initDesktopBridge()`：
  由 `App.tsx:161` 的 `useEffect(() => initDesktopBridge(), [])` 调用——
  **React 挂载之后**，不是模块顶层。
- 真正的 `listen('app:open-file', ...)` 在 `tauri-host.ts:138-144`，
  经由 `desktop-bridge.ts:204` 的 `void a.onOpenFileEvent(...).then(...)` 注册——
  是一个 **async Promise resolve 之后**才生效的监听。
- 因此监听就绪时刻 ≈ `T14`，比 Rust emit 时刻 `T7b` 晚了整整一个 webview 加载 +
  React 挂载 + IPC 往返的窗口（实测冷启动 1~2 秒量级）。

### 2.2 fire-and-forget 在哪些时序窗口会丢

| 窗口 | 现象 |
|---|---|
| `T7b` emit 时，webview 尚未创建（T9 才开始加载） | 事件总线无任何监听者 → 直接丢弃。**冷启动主丢点。** |
| T7b emit 早于 T14（监听 Promise resolve） | 即使 webview 已在加载，监听还没挂上 → 丢弃。 |
| T7b emit 与 T14 之间，前端刷新/重挂载 | 监听者时有时无，事件无重放。 |

Tauri 2 的 `emit` 语义：**不缓冲、不重放、无监听者即丢弃**。所以 setup 阶段一次性 emit
在冷启动下必然落在 T14 之前，必然丢。

---

## 3. 修复方案（Rust-only）

### 3.1 核心思想：把「一次性 emit」改成「有界投递队列 + 隐式 ack」

不再在 setup 阶段 fire-and-forget。改为：

1. **入队**：`open_external_path` 读盘后，把富载荷 `{path,name,text}` 放进
   managed state `StartupQueue`（新模块 `src/startup.rs`），并**立即 emit 一次**
   （热启动/菜单点击场景监听已就绪，这一发就够了）。
2. **有界重发泵**：setup 里 spawn 一个 tokio 任务，每 400ms 扫描队列，对每个未确认
   载荷再 emit 一次，attempts+1；超过 `MAX_ATTEMPTS`（12 次 ≈ 4.8s）仍未确认则放弃并记日志。
   冷启动时第一发（T7b）丢了，泵在 T10~T14 之后的某个 tick 重发，此时监听已就绪 → 命中。
3. **隐式 ack（纯 Rust，零 web 改动）**：前端成功 `routeOpenFile` 后**本来就会**调用
   `bind_native_file(path)`（desktop-bridge.ts:152 → tauri-host.ts:202）。
   把这个既有命令当作「消费确认」：`bind_native_file` 收到与队列中某 pending 载荷
   相同的 path 时，把该载荷从队列摘掉 → 泵停止重发。
   这样**不需要前端任何改动**即可收敛到恰好一次投递。

### 3.2 为什么纯 Rust 能 100% 避免重复加载

- 重发间隔 400ms，而前端 `routeOpenFile` 是同步 `parseKBNote → loadDoc` 后立刻
  `await bindNativeFile(path)`（IPC 往返 ~ms 级）。即一发命中后，ack 在 < 100ms 内回到
  Rust，远小于 400ms 重发间隔 → 下一个 tick 看到已 ack，不再重发。
- 同 path 重复入队（热启动双击同一文件）在入队时即去重：队列里已有同 path 就不再入队。
- 即使极端情况下两发都命中（前端 ack 慢于一个重发间隔），`loadDoc` 用同一份 doc 替换
  当前文档，幂等；且 ack 后立即收敛，不会无限重复。

### 3.3 与既有命令的协调

- `get_startup_file`（lib.rs:369）：原本返回 `current_path`。保持语义不变（它返回的就是
  当前绑定路径），前端目前不调用它；新队列是独立通道，二者不矛盾。
- `bind_native_file`（lib.rs:389）：在既有 `native_bound = path.is_some()` 之后，
  追加一行 `startup::ack(&path)`。

### 3.4 不受影响的路径

- 单实例热启动：回调仍走 `open_external_path` → 入队 + 立即 emit，监听已就绪，一发命中。
- `--diag-export`：T1 拦截，不进 Builder，不碰队列。
- portable 模式：T2 重定向只改数据落盘位置，与事件投递正交。
- 菜单「打开最近」：走同一 `open_external_path`，行为不变。
- 窗口/菜单其余行为：零改动。
- 零网络：泵只在进程内 emit，不发起任何网络请求。

---

## 4. 模块设计（src/startup.rs）

纯逻辑（不依赖 tauri），全部 `rustc --test` / `cargo test` 覆盖：

- `classify_argv(&[String]) -> Option<PathBuf>`：argv[1] 是 `.kbnote` 才返回。
- `QueuedOpen { seq, path, name, text, attempts }`
- `StartupQueueInner`（非线程安全，单测直接用）：
  - `enqueue(path,name,text) -> u64`（同 path 已 pending 则去重，返回已有 seq）
  - `ack(path) -> bool`（摘掉所有同 path 载荷，返回是否摘掉了至少一个）
  - `peek() -> Option<&QueuedOpen>`
  - `pending_paths() -> Vec<String>`
  - `retry_tick(max_attempts) -> Vec<QueuedOpen>`（返回本 tick 要重发的载荷克隆，
    attempts+1，超过 max 的丢弃）
  - `len() / is_empty()`
- lib.rs 里用 `Mutex<StartupQueueInner>` 包一层放进 AppState。

测试用例：无参数 / 有路径 / 非 .kbnote 路径忽略 / 热启动同 path 重复入队去重 /
ack 后清空 / retry_tick 计数与超时丢弃 / peek 不消费。

---

## 5. release-windows 新增冒烟

新增**唯一**新步骤 `Smoke (x64): cold-start open-file delivered 10/10 (no event loss)`：
循环 10 次，每次杀残留 drawpaper、写第 N 个唯一 GUID+序号 金丝雀 .kbnote、以该路径冷启动
exe、有界轮询，断言 drawpaper.log 出现该次 open-file 记录且 recents.json 含该路径。
10 次全过才算过。日志/recents 路径沿用既有冷启动冒烟的双根（Roaming/Local com.drawpaper.app）
递归发现法，不写死 %APPDATA%。arm64 门控 skip 同惯例。**不改任何既有步骤。**

---

## 6. 红线自检

- 版本号字段（Cargo.toml version、tauri.conf.json version、wix.version）零 diff。
- 不打 tag、不碰 develop/main。
- CHANGELOG 只追加 `## 未发布（Unreleased）` 段。
- 不碰 packages/web/**、ci/*.ps1、README、tauri.conf.json。
