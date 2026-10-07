# Wave16-I：Windows 便携模式（U盘运行）设计说明

> 分支：`feat/win-portable-mode`（基线 `origin/develop` = 73cf8ad，v0.1.0-rc.7）。
> 本文是设计/边界说明；面向最终用户的操作指南见 [`../windows-user-guide.md` §便携版](#)。

## 1. 目标

让同一个 `drawpaper.exe` 既能走安装版（NSIS，数据在 `%APPDATA%` / `%LOCALAPPDATA%`），也能直接拷到 U 盘/移动硬盘里**零安装运行**，且便携运行时产生的全部数据落在 exe 旁边的 `./data/`，与安装版**完全互不干扰**。

## 2. 触发条件

启动时探测 exe 同目录，满足任一即进入便携模式：

1. 存在空标记文件 `drawpaper.portable`（与 exe 同级，内容任意/空文件即可）；**或**
2. 已经存在 `data/` 目录（便于老用户直接建目录）。

标记缺失且无 `data/` 目录 → 维持现状（安装版路径），行为与未做本特性前逐字节一致。

## 3. 机制：复用 Tauri 官方 `appDirectoriesOverride::Root`

没有自己拼第二套路径。启动时在**构建 App 之前**做一次纯函数决策，若决定便携，则把 Tauri 的路径解析器根整体改写到 `<exe_dir>/data`：

```rust
context.config_mut().app.app_directories_override =
    Some(AppDirectoriesOverride::Root(exe_dir.join("data")));
```

Tauri 2.12 的 `Root` 覆写语义（见 `tauri-utils` config 文档与源码测试）：

| 解析器方法 | 安装版（未覆写） | 便携版（Root=<exe>/data） |
|---|---|---|
| `app_config_dir()` | `%APPDATA%\com.drawpaper.app` | `<exe>\data` |
| `app_data_dir()` | `%APPDATA%\com.drawpaper.app` | `<exe>\data` |
| `app_local_data_dir()` | `%LOCALAPPDATA%\com.drawpaper.app` | `<exe>\data` |
| `app_log_dir()` | `%LOCALAPPDATA%\com.drawpaper.app\logs` | `<exe>\data\logs` |
| `app_cache_dir()` | `%LOCALAPPDATA%\com.drawpaper.app\cache` | `<exe>\data\caches` |

因为路径解析器本身被移动了，仓库里**所有**取目录的调用点自动跟随，不需要逐个改：

- `drawpaper-recents.json` / `drawpaper-autosave.json`（`app_config_dir`）
- `backups\*.kbnote`（`app_data_dir/backups`）
- `drawpaper.log`（tauri-plugin-log 的 `LogDir` → `app_log_dir`）
- `window-state.json`（tauri-plugin-window-state 内部用 `app_config_dir`）
- 帮助 → 打开数据目录（`app_data_dir`）
- **WebView2 EBWebView 用户数据目录**（Tauri 在 Windows 上强制把 webview data dir 设为 `app_local_data_dir()`，见 `tauri-2.12.1/src/manager/webview.rs:561-569`）

## 4. 纯函数决策（可单测，无 `#[cfg(windows)]`）

`apps/desktop-tauri/src-tauri/src/portable.rs`：

- `decide_portable(&PortableProbe) -> PortableDecision`：纯函数，输入 `exe_dir`、`marker_present`、`data_dir_present`、`platform`、`portable_dir_writable`，输出 `override_root: Option<PathBuf>` + `portable: bool` + 人可读 `reason`。
- 激活三条件**同时**成立：平台是 Windows **且** 有触发标记 **且** `./data` 可写；任一不满足 → 返回 `None`（回退系统目录）并在 `reason` 里写明原因。
- `probe_exe_dir()` 是唯一碰文件系统的地方：探测标记/目录存在性，并对 `./data` 做「建目录 + 写探针文件 + 删除」可写性探测；失败一律降级为不可写，绝不 panic。
- 非 Windows 平台（开发机 Linux/mac）即便有标记也**不**进便携模式，避免把仓库 checkout 里的 `data/` 当成触发。

单测覆盖 6 例（`cargo test` 主机跑）：标记存在→`./data`；无标记无 data/→系统目录；`./data` 不可写→安全回退；仅有 data/ 目录也触发；非 Windows 不触发；有标记但不可写也回退。

## 5. 便携目录树（运行后长这样）

```
drawpaper/                       ← U盘根
├─ drawpaper.exe
├─ drawpaper.portable            ← 空标记文件（触发条件 1）
└─ data/
   ├─ drawpaper-recents.json     ← 最近文件
   ├─ drawpaper-autosave.json    ← 自动保存文件夹元数据
   ├─ window-state.json          ← 窗口位置/尺寸（由插件自动写）
   ├─ backups/                   ← 时间戳 .kbnote 快照
   ├─ logs/drawpaper.log         ← 运行日志
   ├─ caches/
   └─ EBWebView/                 ← WebView2 用户数据（IndexedDB/OPFS 等）
```

升级时直接用新 `drawpaper.exe` 覆盖旧 exe，`data/` 不动，最近文件/窗口状态/备份/Web 存储全部保留。

## 6. WebView2（EBWebView）边界结论

**结论：本波通过 `Root` 覆写把 WebView2 用户数据目录一并重定向到了 `./data/EBWebView`，不是只重定向 Rust 侧文件。**

依据：Tauri 在 Windows 上若未在 conf 里显式指定 webview `data_directory`，会强制使用 `app_local_data_dir()`（`src/manager/webview.rs`）。`Root` 覆写同时把 `app_local_data_dir()` 指向 `<exe>/data`，因此 WebView2 的 UDF 自然落在 `./data` 内。

仍需如实标注的残余边界：

- **WebView2 运行时本身（Evergreen Runtime）**不在 `./data`——它是系统共享组件（Win11 自带/Win10 首启自动装），多份 drawpaper 共用；这不是本 app 的数据，不影响便携性。
- **文件关联 `.kbnote`、开始菜单快捷方式、注册表**由 NSIS 安装器注册，**便携版不写注册表**。U 盘里双击 `.kbnote` 不会自动唤起便携版（系统仍指向安装版或弹「打开方式」）；这是有意为之——便携版零安装、零注册表。
- 若 `./data` 不可写（如 CD-ROM、只读 U盘锁死），本波**回退到系统目录**而不是硬写便携目录；此时日志/数据会回到 `%APPDATA%`，并在启动 stderr 写明原因。不会 panic。
- `single-instance`、`notification` 等插件不持有持久化数据，不受影响。

## 7. 冒烟脚本

`apps/desktop-tauri/ci/smoke-portable.ps1`：自包含 PowerShell 脚本，可手动独立运行（不依赖任何 CI 环境变量）。它在临时目录构造便携树 → 放标记 → 启动 exe → 断言 `data/` 下出现日志/recents 且系统 AppData 无新增 → 清理进程。

**本波未把它接进任何 GitHub workflow**（按红线要求）。后续由 MainAgent 在 `release-windows.yml` 里统一接线。

## 8. 红线遵守

- 只改 `apps/desktop-tauri/src-tauri/**`、新增 `apps/desktop-tauri/ci/smoke-portable.ps1`、`docs/**`、`CHANGELOG.md`。
- 未改 `tauri.conf.json` 的 `version` / `bundle.targets` / `plugins` 等任何键；本特性零 conf 改动（纯运行时 context 覆写）。
- 未改 `.github/workflows/**`、`packages/**`，未动版本号。
