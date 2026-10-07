# Wave15 C — Windows 诊断信息导出

> 范围：纯 Rust 桌面壳改动，web 侧零改动。新增菜单「帮助 → 导出诊断信息」与隐藏无头
> CLI `drawpaper.exe --diag-export <zip>`，两者共用同一份收集核心。

## 1. 动机

用户报 bug（崩溃 / 白屏 / 同步失败 / 快捷键失灵）时，此前让用户手动去
`%APPDATA%\com.drawpaper.app\logs\drawpaper.log` 翻尾部日志——门槛高、易漏、还可能
顺手把 `.kbnote` 备份也一起打包发来。本特性一键产出一个**隐私安全**的 zip，用户可直接
附在 Issue 里。

## 2. 两条入口，一个核心

| 入口 | 触发 | 行为 |
|---|---|---|
| 菜单 | 帮助 → 导出诊断信息…（id `help:export-diagnostics`） | 原生 Save 对话框（默认 `drawpaper-diagnostic-YYYYMMDD.zip`）→ 收集 → 原生消息框反馈成功/失败；**取消不报错** |
| CLI | `drawpaper.exe --diag-export <zip路径>` | 不弹窗、不开 webview、不进主循环，直接收集写出后以进程码退出（0 成功 / 非 0 失败）。CI 无头冒烟与故障排查用 |

两者都调用 `diagnostics::write_diagnostic_zip(data_dir, log_path, out_zip)`（见
`apps/desktop-tauri/src-tauri/src/diagnostics.rs`）。CLI 在 `lib.rs::run()` 构建任何
Tauri 插件（含 single-instance）**之前**拦截 argv，所以即使 app 已在运行，`--diag-export`
也不会被单实例插件吞掉。

## 3. zip 内容

固定四个条目：

| 条目 | 内容 |
|---|---|
| `system.json` | app 版本（`CARGO_PKG_VERSION`）、OS、OS 版本（`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` 的 ProductName/DisplayVersion/CurrentBuild.UBR）、架构（`std::env::consts::ARCH`）、WebView2 Runtime 版本、收集时间（RFC3339 UTC） |
| `logs/drawpaper.log` | 日志尾部，**最多约 256KB**（seek 到 `len-256K` 读到底） |
| `files-manifest.json` | 数据目录递归清单，数组；每条**只有** `{name, size, mtime}` 三个字段 |
| `README.txt` | 包内容与隐私边界说明 |

WebView2 版本探测（`winreg`）依次尝试：
- `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 的 `pv`
- `HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 的 `pv`

读不到则记 `"unknown"`，不致命。

## 4. 隐私红线（强制）

- **绝不读取/打包任何 `.kbnote` 正文与 `assets/` 资产字节。**
- 数据目录 walk 只调用 `read_dir` + `metadata` 取元数据，**从不 `File::open` 业务文件**。
- 整个包里唯一被读字节的文件是白名单内的 `logs/drawpaper.log`。
- `files-manifest.json` 仍然会**列出** `.kbnote` 与 assets 文件的相对路径/大小/mtime
  （仅元数据，便于支持判断数据布局），但不打包它们的字节。

## 5. 可测性

收集核心是纯函数，单元测试在 Windows runner 上随 `cargo test` 跑：

- `zip_never_leaks_note_or_asset_bytes`：埋 `SECRET-canary.kbnote`（正文=唯一金丝雀串）
  与 `assets/img.png`（字节=金丝雀串），断言 zip 无 `*.kbnote` 条目、无 `assets/` 条目、
  全部展开内容金丝雀串零命中、manifest 每条恰好 3 字段、system.json 关键字段存在。
- `log_tail_is_capped`：写 1MB 日志，断言只收尾部且含尾标记。
- `default_filename_is_yyyymmdd`：默认文件名格式。

## 6. CI 冒烟（release-windows x64）

静默安装后在 `%APPDATA%\com.drawpaper.app\` 埋 `SECRET-canary.kbnote`（正文=唯一金丝雀串）
与 `assets/img.png`，命令行跑 `drawpaper.exe --diag-export %TEMP%\dp-diag.zip`（有界 60s
等待），展开后断言：

- zip 无任何 `*.kbnote` 条目、无 `assets/` 条目；
- 全部展开文件 grep 金丝雀正文零命中；
- `system.json` 含 version / arch / webview2_runtime_version 字段；
- `files-manifest.json` 每条只有 name/size/mtime。

## 7. 新增依赖 / 权限

- `Cargo.toml`：`zip`（纯 Rust 写包，deflate）、`winreg`（注册表探测）。
- `capabilities/default.json`：**零改动**（对话框在 Rust 侧直接调用，不经 web IPC，不受
  capability 门控；现有 `dialog:allow-message` / `dialog:allow-save` 本就存在）。
- web 侧：**零改动**。菜单事件在 Rust 侧拦截后直接 return，不向 web 转发。
