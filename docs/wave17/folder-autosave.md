# Wave17 · 原生文件夹自动保存（Desktop Folder Auto-Save）

> 分支：`feat/desktop-folder-autosave`。
> 一句话：Tauri 桌面端让用户选定一个本地文件夹，文档变更（500ms 防抖）由宿主直接把
> `.kbnote` 文档与其引用资产落盘到该目录；**布局/格式/资产命名与 web 现有 FSA 同步通道逐字节一致**。

## 1. 为什么做

web 端已有两条本地持久化路径：

1. **OPFS + IndexedDB**（Wave14）：主 durability net，浏览器/桌面通用；
2. **FSA 同步通道**（`packages/web/src/sync/fsachannel.ts`）：用户选一个原生目录，把文档
   推/拉成 `.kbnote` + `assets/`，可在 Explorer 里看见、可被 OneDrive 同步。

Wave17 在此之上加**第三条、也是桌面端最直觉的一条**：选好文件夹后，**每次编辑自动镜像落盘**，
不需要用户手动「同步」。它是一条纯本地磁盘 IO 的 durability mirror，不进同步/冲突/协作语义。

## 2. 与 FSA 通道的关系（关键：复用同一套格式，不写第二套）

| 维度 | FSA 同步通道 | 本功能（native autosave） |
|---|---|---|
| 文档字节 | `serializeKBNote(syncStamper.stampForPersist(doc))` | **同一个函数**，逐字节相同 |
| 文档路径 | `<docId>.kbnote`（目录根） | **相同** |
| 资产路径 | `assets/<assetRef>`（assetRef = SHA-256 hex） | **相同** |
| 资产字节来源 | OPFS `getAsset(ref)` | **相同** |
| 触发 | 用户手动「同步」/ 定时推拉 | store 文档变更 500ms 防抖自动 |
| 冲突合并/水位/GC | 有（CRDT vv 合并） | **无**——单向镜像，不读回、不合入 |
| 方向 | 双向（push/pull） | 单向（host → disk） |

**红线**：Rust 端**不解析、不改写文档 JSON**——`.kbnote` 字节由 web 侧用既有
`serializeKBNote` 产出后 base64 传给 Rust，Rust 只做「受困于选定目录内」的纯磁盘写入。
core 保持零 DOM、序列化逻辑仍在 core 纯函数里。

## 3. 落盘目录布局（与 FSA 一致）

```
<用户选定文件夹>/
├── <docId-A>.kbnote        # 文档本体（FSA 同名）
├── <docId-B>.kbnote
└── assets/
    ├── <sha256-of-asset>   # 内容寻址二进制（FSA 同名同内容）
    └── <another-sha256>
```

证据：web adapter 的 `docRelPath(docId)` / `assetRelPath(ref)` 与
`fsachannel.ts` 的 `pushDoc`/`pushAsset` 路径规则一一对应；e2e 断言
`relPath` 以 `.kbnote` 结尾、资产走 `assets/` 前缀。

## 4. 架构

### Rust（`apps/desktop-tauri/src-tauri/src/native_autosave.rs`）

- 纯函数（无 IO，单测直测）：
  - `is_safe_relative(rel)`：拒绝绝对路径、盘符前缀、`..` 穿越、NUL；`\` 统一当 `/`。
  - `join_within(base, rel)`：把清洗后的相对路径 join 到选定目录，构造上保证受困。
- 配置持久化：app 配置目录下 `drawpaper-autosave.json`（`{"dir": "..."}`），与
  `drawpaper-recents.json` 同款 JSON 范式；取消时写 `{"dir": null}`。
- 命令（`window.__TAURI__.core.invoke`）：
  - `autosave_pick_dir`：原生目录对话框，选中即写 state + 持久化。
  - `autosave_get_dir` / `autosave_clear_dir`：查询 / 取消。
  - `autosave_write_file(rel_path, bytes_base64)`：受困目录写文件，自动建父目录；
    路径穿越 / base64 解码失败 / IO 失败一律 `Err`，web 侧降级，不 panic。
  - `autosave_dir_writable`：写探针文件再删除，探测目录可写性。
- 隐藏无头自检：`--native-autosave-selftest <dir>`（builder 前拦截，不弹窗不开 webview）：
  写一份测试 `.kbnote`+`assets/`，读回校验字节一致，再断言 `../evil` / 绝对路径被拒绝。
  本地手动冒烟用；CI 仍以双架构编译 + web-ci 为权威门，不加 flaky UI 冒烟。

### web（`packages/web/src/host/native-autosave-adapter.ts`）

- 仅新增 host 层文件 + `App.tsx` 一行 `useEffect(() => initNativeAutosave(), [])` 注册。
- Tauri 且目录已配置时：订阅 `editorStore`，文档引用变化 → 500ms 防抖 →
  `serializeKBNote(stampForPersist(doc))` 写 `<docId>.kbnote`；遍历 `doc.assetRefs`，
  把本会话未写过的 ref 从 OPFS `getAsset(ref)` 读出写到 `assets/<ref>`（内容寻址幂等）。
- 失败静默降级：写盘失败只 console.warn，Dexie/OPFS 主保存不受影响。
- 设置面板：`SyncSettingsDialog` 内加一个 Tauri 门控区块（选择/更换/取消文件夹），
  浏览器渲染 null，既有同步测试零变化。

## 5. 降级矩阵

| 环境 / 状态 | 行为 |
|---|---|
| 浏览器（无 `__TAURI__`） | adapter 整体 no-op；现有 OPFS/IndexedDB 自动保存不变 |
| Tauri 但未配置目录 | `autosave_get_dir` 返回 null → no-op；设置面板显示「选择文件夹」 |
| 用户在原生对话框点取消 | `autosave_pick_dir` 返回 null → 不改状态，继续 no-op |
| 配置目录被删除/不可写 | 写命令 `Err` → web 侧静默降级；下轮防抖重试；不阻断主保存 |
| 写盘 IO 失败（磁盘满/权限） | 同上；Dexie 仍是 durability net |
| 用户点「取消自动保存」 | 清 state + 配置写 `{"dir": null}`；镜像停用 |

## 6. 隐私 / 本地优先

- **零网络**：本功能只碰本地磁盘，无任何外联；不引入新依赖、不进主 chunk/precache。
- 目录由用户显式选择，配置只存在本机 app 配置目录；不上传、不同步到任何远端。
- 用户可随时在设置里取消，取消后仅清配置文件，**不删除**已落盘的文档（用户自己的文件）。
- 浏览器路径完全 no-op，OPFS 行为与 rc.8 完全一致。

## 7. 验证

- Rust：`native_autosave` 路径安全纯函数单测（`is_safe_relative` / `join_within`：
  正常相对路径接受、`..`/反斜杠穿越拒绝、绝对路径/空拒绝、join 受困）；
  msvc `cargo check --target x86_64-pc-windows-msvc` 0 error（权威门为 release-windows CI）。
- web：adapter 纯逻辑单测（路径映射、base64 往返、资产去重、写盘失败降级、浏览器 no-op）。
- e2e：mock `__TAURI__` → 配置目录 → 编辑 → 断言按 FSA 同款路径收到 `<docId>.kbnote`
  写调用；取消配置后再编辑不再产生写调用。
