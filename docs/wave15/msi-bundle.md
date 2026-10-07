# Wave 15 B 路：Windows 安装包矩阵增加 WiX MSI（x64 + arm64）

> 分支：`feat/win-msi-bundle`（基线 `origin/develop` = 73cf8ad）。
> 目的：在现有 NSIS（`-setup.exe`）矩阵之外，**同一次 `tauri build` 同时产出 WiX MSI（`.msi`）**，x64 / arm64 各一份，凑齐 4 个安装包；publish job 把 4 个产物全部放进 GitHub Release。
> 红线：只动本分支；不改版本号字段；不建 tag；publish 仍只在 tag 触发；不改 `plugins` 段（A 路在 `feat/win-updater` 加 updater）；不改 `webviewInstallMode`（C 路在 `feat/win-diagnostics-webview2` 评估离线引导）。

## 1. 改动一览

| 文件 | 改动 |
|---|---|
| `apps/desktop-tauri/src-tauri/tauri.conf.json` | `bundle.targets` 由 `["nsis"]` 改为 `["nsis","msi"]`；`bundle.windows.wix` 段暂留空（全默认，见 §3）；**不动** `plugins` / `fileAssociations` / `nsis` 段 / `version` |
| `.github/workflows/release-windows.yml` | `on.push.branches` 追加 `'feat/win-msi-bundle'`；matrix `extra_args` 改 `--bundles nsis,msi`（arm64 同加 `--target aarch64-pc-windows-msvc`）；新增 MSI artifact 上传 `msi-${{matrix.arch}}`；publish 下载 4 个 artifact、`SHA256SUMS.txt` 覆盖 4 产物（断言 ≥4 行）、release files 同时含 `*.exe` 与 `*.msi`；新增 x64 MSI 冒烟 5 步 |
| `docs/wave15/msi-bundle.md` | 本文 |
| `docs/windows-user-guide.md` | 安装包矩阵说明（NSIS 推荐 / MSI 企业部署） |
| `CHANGELOG.md` | `## 未发布（Unreleased）` 段 |

**第一个提交**只在 `on.push.branches` 追加分支字面量（`5cb6e03`），先推确认 Windows CI 触发；真正的打包 / 冒烟改动在后续提交。

## 2. 安装包矩阵（4 个产物）

| 格式 | 架构 | artifact 名 | 产物路径 | 上传 |
|---|---|---|---|---|
| NSIS | x64 | `nsis-x64` | `target/**/release/bundle/nsis/*-setup.exe` | 既有 |
| NSIS | arm64 | `nsis-arm64` | 同上（`aarch64-pc-windows-msvc` target） | 既有 |
| WiX MSI | x64 | `msi-x64` | `target/**/release/bundle/msi/*.msi` | **新增** |
| WiX MSI | arm64 | `msi-arm64` | 同上 | **新增** |

publish job（仅 tag 触发）下载全部 4 个，`SHA256SUMS.txt` 一行一个产物（basename），断言行数 ≥ 4；release assets 同时含 `*.exe` 与 `*.msi`。

## 3. WiX 模板默认行为核实（以 CI 实测为准）

Tauri 2.1 的 MSI 由 WiX Toolset v3 打包，模板是 Tauri 内置的 handlebars `Product.wxs`。本路先用全默认跑，用 CI 冒烟逐项验证；实测缺什么再用官方 fragment 补。

### 3.0 MSI 版本号（首个实测坑，已解决）

首次实跑双架构都在 `tauri build` 阶段直接红：

```
Error failed to bundle project: optional pre-release identifier in app version
must be numeric-only and cannot be greater than 65535 for msi target
```

MSI `ProductVersion` 必须是 `major.minor.patch.build`（纯数字，major≤255，build≤65535），**不接受 semver 的 `rc.` 这种非数字 prerelease 段**。app 版本是 `0.1.0-rc.7`，NSIS 不挑剔直接过，MSI 直接拒绝。

按红线不改 app 版本字段，改用官方 MSI-only 覆盖 `bundle.windows.wix.version`（[Tauri 配置](https://schema.tauri.app/config/2)：`WixConfig.version`，缺省时才从 app version 推导）：

```jsonc
"windows": {
  "nsis": { ... },   // 不动
  "wix": { "version": "0.1.0.7" }   // 仅 MSI 包 ProductVersion
}
```

即 `0.1.0-rc.N` → MSI `0.1.0.N`。**app 对外版本仍是 `0.1.0-rc.7`**（exe 版本资源、关于框、NSIS 包名都不变）；改 rc 号时需要同步把这里的 build 段 +1。

### 3.1 默认行为逐项核实

| 能力 | 期望默认行为 | 本路是否补齐 | 实测结论 |
|---|---|---|---|
| 安装范围 | WiX MSI 固定 **per-machine**（`InstallScope=perMachine`），落 `C:\Program Files\drawpaper` | 不需要 | （CI 填写） |
| `.kbnote` 文件关联 | Tauri 据 `bundle.fileAssociations` 生成 HKLM `Software\Classes\.kbnote` 注册项 | 不需要 | （CI 填写） |
| 开始菜单快捷方式 | 模板内置 `ApplicationProgramsMenuFolder` 组件 | 不需要 | （CI 填写） |
| 桌面快捷方式 | 模板是否内置存疑 | 缺则补 fragment | （CI 填写） |
| WebView2 引导 | 默认 `webviewInstallMode={type:"downloadBootstrapper", silent:true}`，**两个格式一致**，安装包不内置引导（0MB 增量），装包时按需下载 | 不改（C 路评估离线引导） | （CI 填写） |

> 凡是冒烟断言失败的项，用官方机制 `bundle.windows.wix.fragmentPaths` + `componentRefs` 补一个 `.wxs` fragment，而不是手改模板。

### 3.1 WebView2 行为差异（如发现）

默认 `webviewInstallMode` 对 NSIS / MSI 一致：都是 `downloadBootstrapper`。Win10 1803+ / Win11 系统自带 WebView2；老系统首次安装时引导联网下载。本路**不切换**到 `embedBootstrapper` / `offlineInstaller`（那是 C 路的评估项）。若 CI 实测发现 MSI 与 NSIS 在 WebView2 引导上有差异（例如 MSI 静默安装时引导弹框），只在此记录，不在本分支改。

## 4. MSI 冒烟（仅 x64，NSIS 卸载后的干净状态上跑）

排在 NSIS 7 断言之后串行执行；NSIS 卸载已把 per-user 目录清掉，MSI 是 per-machine 落到 Program Files，两者目录不重叠。

| # | step | 断言 |
|---|---|---|
| 1 | silent MSI install | 定位 `target/**/bundle/msi/*.msi`；`msiexec /i <msi> /qn /norestart /lv* <log>` 有界等待 180s；退出码 0 或 3010；exe 存在（候选路径数组探 Program Files / Program Files(x86) / LOCALAPPDATA 并打印命中）；ProductVersion 与 tauri.conf 数字 token 归一化一致（复用 NSIS 写法） |
| 2 | `.kbnote` 注册表关联 | HKLM / HKCU 双探测，默认值非空即过 |
| 3 | 桌面 + 开始菜单快捷方式 | 用户 / 公共桌面、用户 / 公共开始菜单，至少各命中一个 |
| 4 | 启动后主窗口标题 | 启动后轮询 20s，进程存活且 `MainWindowTitle` 含 `drawpaper`，随后强杀 |
| 5 | silent MSI uninstall | `msiexec /x <msi> /qn /norestart` 有界等待，轮询 60s 断言安装目录移除 |

arm64 MSI **只构建不执行**（runner 是 x64 硬件，aarch64 PE 起不来，与现有 NSIS arm64 门控同理）。NSIS 现有 7 断言一条不动。

## 5. 安装包体积对比

从本分支 CI 构建日志 / artifact 取 4 个包实际 MB 数，与 rc.7 NSIS 基线对比：

| 产物 | rc.7 基线 | 本分支实测 | Δ |
|---|---|---|---|
| NSIS x64 | ~3.2 MB | （CI 填写） | |
| NSIS arm64 | ~3.1 MB | （CI 填写） | |
| MSI x64 | — | （CI 填写） | |
| MSI arm64 | — | （CI 填写） | |

## 6. 红线自检

- 只 push `feat/win-msi-bundle`；不碰 develop / main；不建 / 推 tag；不改任何 `version` 字段（tauri.conf.json / Cargo.toml / Cargo.lock / package.json）。
- `plugins` 段不动（A 路 updater 在另一分支）。
- `webviewInstallMode` 不动（C 路离线引导在另一分支）。
- 不改任何 Rust / Cargo / capabilities。
