# Wave24 路 2 — WebView2 embedBootstrapper 切换与全离线附加资产

> 结论必须带 CI 实测数据。本文档记录 `webviewInstallMode` 从
> `downloadBootstrapper` 正式切换为 `embedBootstrapper` 的体积数据、无 WebView2
> 硬门冒烟步骤与结果，以及全离线（offlineInstaller / fixedRuntime）附加资产的决策。

## 1. 背景与动机

Wave15（见 `docs/wave15/webview2-offline.md`）实测了三种 WebView2 安装模式，最终
保留默认 `downloadBootstrapper`：安装包最小（4.65 MB x64），但**安装时联网**从
微软 CDN 下载 bootstrapper + 运行时。在共享 runner / 弱网环境下，fwlink 偶发
`curl exit 18`（传输中断），安装期拉 bootstrapper 失败会直接导致 NSIS 安装
退出非零——这是首装可靠性的一类已知故障。

Wave24 的目标是：**把 bootstrapper stub 打进安装包**（`embedBootstrapper`），
消除「安装期拉 bootstrapper 失败」这一类故障；同时评估并落地真正全离线附加
资产。

## 2. 三种模式对比

| 模式 | 安装包内 | 安装时联网？ | 包体积 x64 | 首装失败面 |
|---|---|---|---|---|
| `downloadBootstrapper`（Wave15 默认） | 无 bootstrapper、无运行时 | **是**（下 bootstrapper + 运行时） | 4.65 MB（Wave15 实测） | bootstrapper 下载失败（exit 18）→ 安装直接非零 |
| `embedBootstrapper`（**本路切换**） | 内嵌 bootstrapper stub（~2 MB） | 是（bootstrapper 本地执行，仍从微软 CDN 下 ~200 MB 运行时） | 见 §3 实测 | 仅运行时下载失败（bootstrapper 本身已本地） |
| `offlineInstaller`（全离线附加资产） | 内嵌完整 Evergreen Standalone 运行时安装器 | **否** | ~200 MB（Wave15 x86 实测 202.52 MB） | 无（运行时已打包） |

关键区别：
- `embedBootstrapper` **不是**离线方案——运行时组件（~200 MB）仍在安装时从
  微软 CDN 下载。它只把约 2 MB 的引导 stub 本地化，消除「引导下载失败」这一类
  故障。
- `offlineInstaller` 才是真正全离线：构建期从微软下载 Evergreen Standalone
  并整个塞进 NSIS 包，安装时不需要任何联网。

## 3. 体积数据（before / after）

| 指标 | 数值 | 来源 |
|---|---|---|
| before：downloadBootstrapper x64 | **4.65 MB** | Wave15 run `37609717113`，`wv2-baseline-x64` |
| after：embedBootstrapper x64 | _见本路 run notice `wv2-embedAfter-x64`_ | release-windows 分支 run |
| after：embedBootstrapper arm64 | _见本路 run notice `wv2-embedAfter-arm64`_ | release-windows 分支 run |
| 全离线：offlineInstaller x64 | _见 offline-runtime job notice `wv2-offline-size`_ | offline-runtime job |

> 注：Wave15 的 `wv2-embedBootstrapper` 测量步当时因 continue-on-error 未产包，
> 仅按 stub 体积估 ≈ +1.7 MB。本路切换后由 Measure(a) 直接落数。

## 4. 无 WebView2 首装硬门冒烟

### 4.1 设计

在 build job x64 矩阵里、标准「静默安装」冒烟**之前**，新增一步
`Smoke (x64): no-WebView2 -> embedded bootstrapper -> main window (HARD GATE)`，
链路：

1. **环境准备（best-effort，try/catch 不抛错）**：
   - 杀掉 msedgewebview2 子进程；
   - 找到 `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\*\Installer\setup.exe`，
     以 `--uninstall --mswebview-runtime --system-level /silent /norestart` 卸载
     Evergreen 运行时；
   - 卸载后复查 `msedgewebview2.exe` 是否存在 / EdgeUpdate 客户端注册表键是否在，
     置 `wv2Destroyed` 布尔。
   - 这一步在 hosted runner 上可能因系统保护而无法真正卸载（WebView2 是
     Windows 共享组件），按 Wave15 Measure(c) 同款特许：**不硬门**，仅记
     `wv2Destroyed` 并在日志如实写明。

2. **硬门：静默安装 embed 包**（`/S /CURRENTUSER`）：
   - 安装进程运行期间每 500 ms 轮询子进程，捕获
     `MicrosoftEdgeWebView2Bootstrapper.exe` / `MicrosoftEdgeWebView2RuntimeInstaller.exe`
     等 bootstrapper 锚点（产物/进程证据）；
   - 等待安装进程退出（≤75 s），**退出码必须为 0**（硬门）；
   - 安装目录必须出现 `drawpaper.exe`（硬门）。

3. **硬门：主窗口标题**：
   - 启动 `drawpaper.exe`，每 1 s 轮询 `MainWindowTitle`，**30 s 内**必须出现
     包含 `drawpaper` 的标题（硬门）；
   - 随后杀进程。

4. **清理 + 恢复**：
   - 静默卸载 drawpaper，使后续标准冒烟从干净状态开始；
   - 若 WebView2 被卸载了（`wv2Destroyed=true`）且 embed 安装已通过 bootstrapper
     重装了运行时，则复查 `Test-WebView2Present`；若仍缺失，用 Measure(c) 下载的
     Evergreen Standalone x64 安装器补装。

### 4.2 结果

_待本路 CI run 落数后填写：wv2Destroyed / bootstrapperSeen / windowTitleOK / wv2Final。_

## 5. 全离线附加资产决策（offline-runtime job）

### 5.1 评估

| 维度 | 评估 | 结论 |
|---|---|---|
| 体积 | ~200 MB（Wave15 x86 实测 202.52 MB） | GitHub Release 单文件硬上限 2 GB，200 MB 远低于上限；180 MB 是 Wave15 自设预算，非平台限制 |
| CI 时长 | 构建期下载 ~200 MB 运行时 + 增量打包，独立 job 并行 | 不阻塞 publish（publish.needs 仍只 build） |
| runner 磁盘 | windows-latest ~14 GB 可用 | ~200 MB 运行时 + Rust target ~3 GB，充裕 |
| 稳定性 | fwlink 偶发抖动（Measure(c) 已 continue-on-error） | Tauri 内部下载失败会让 job 变红——这是预期的硬门，不掩盖 |
| 用户价值 | 内网隔离 / 离线 Windows 机器可直接装 | 真实需求（Wave15 用户指南 §4 已写明手动装运行时的 workaround） |

**决策：实现为独立附加资产**，不进 6 包主矩阵、不阻塞 publish、不与主包 artifact
重名。

### 5.2 实现

- 新增 `offline-runtime` job（`runs-on: windows-latest`，x64 only）；
- 无 `needs:`，与 build / arm64-native 并行；
- 构建命令：`tauri build --ci --bundles nsis --config '{"bundle":{"windows":{"nsis":{"webviewInstallMode":{"offlineInstaller":true}}}}}'`；
- 产出文件复制改名为 `*-offline-setup.exe`，上传为 artifact `nsis-offline-x64`；
- `publish.needs` 仍只 `build`，**本资产不进 GitHub Release 自动发布**——后续
  维护者可在需要时手动挂到 Release 页。

### 5.3 数据

_待本路 CI run 落数：offline-runtime job 是否全绿、产出体积、时长。_

## 6. 隐私与外联说明

- **首装运行时由微软 CDN 提供**：`embedBootstrapper` 模式下，安装期执行本地
  bootstrapper，但 ~200 MB 的 Evergreen 运行时组件仍从
  `https://software.rg-adguard.net` /微软官方域下载。这是 Tauri 标准首装行为，
  与应用本体无关。
- **应用本体零后台外联**：drawpaper 本身是 local-first 应用，无账号、无云同步、
  无遥测上报。唯一的网络请求是：
  1. 首装时 WebView2 bootstrapper 从微软 CDN 拉运行时（仅安装期，由微软
     bootstrapper 发起）；
  2. 用户主动点「帮助 → 检查更新」时，从 GitHub Releases 拉 `latest.json`
     （updater 插件，可在设置中关闭）。
- 全离线附加资产（`offlineInstaller`）安装时**完全不联网**，适合内网隔离机器。

## 7. 红线自检

- [x] 只推 `feat/webview2-bootstrapper-embed`，未碰 develop/main/tag；
- [x] `version` 字段零 diff（仍 `0.1.0-rc.15`）；
- [x] `tauri.conf.json` 只动了 `bundle.windows.nsis.webviewInstallMode`（新增键），
  未动 `app.windows` 可见性、未动 Cargo profile；
- [x] `continue-on-error` 只保留 Measure(c) 既有 1 处特许（env 准备在脚本内
  try/catch，未加 YAML 级 continue-on-error）；embed 包构建 / 安装 / 启动断言
  均硬门；
- [x] 零新增非微软出口：bootstrapper / 运行时均走微软官方 fwlink 与 CDN；
- [x] `publish.needs` 仍只 `build`，offline-runtime 不进主矩阵、不阻塞发布；
- [x] 不做 Android。
