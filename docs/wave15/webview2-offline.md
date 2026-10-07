# Wave15 C — WebView2 离线安装策略实测

> 结论必须带 CI 实测数据，不允许凭印象。本文件记录三种 webviewInstallMode 的包体积取数与
> 最终取舍。实测由 `.github/workflows/release-windows.yml` 在每次推送时自动复跑。

## 1. 背景

Tauri 2 NSIS 的 `bundle.windows.nsis.webviewInstallMode` 未设置时，默认
`downloadBootstrapper`：安装包很小，但**装的时候要联网**下载 WebView2 Evergreen
Runtime。对完全离线 / 内网隔离的 Windows 机器不友好。

候选方案：

| 方案 | 安装包内 | 安装时联网？ | 包体积 |
|---|---|---|---|
| `downloadBootstrapper`（当前默认） | 无运行时 | 是（下载引导+运行时） | 最小 |
| `embedBootstrapper` | 内嵌引导小 stub | 是（引导仍联网下运行时） | 略增 |
| `offlineInstaller` / 固定版运行时 | 内嵌完整 Evergreen Standalone 运行时安装器 | **否** | 大幅增加 |

## 2. 实测方法（CI 自动取数）

release-windows x64 矩阵里加了三个测量步骤（见 workflow）：

- **(a) 基线**：当前 conf（downloadBootstrapper）产出的 `*-setup.exe` 体积。
- **(b) embedBootstrapper**：用 `tauri build --config '<json>'` **内联覆盖**配置，
  不改 `tauri.conf.json` 落盘，输出到独立 `target-embed/` 目录避免覆盖基线包。
  JSON：`{"bundle":{"windows":{"nsis":{"webviewInstallMode":{"embedBootstrapper":true}}}}}`
- **(c) Microsoft Evergreen Standalone Runtime 安装器**：CI 直接下载官方 fwlink 并打印体积：
  - x64 → `https://go.microsoft.com/fwlink/p/?LinkId=2124703`
  - x86 → `https://go.microsoft.com/fwlink/p/?LinkId=2124701`
  - arm64 → `https://go.microsoft.com/fwlink/p/?LinkId=2124699`

## 3. 实测数据表

> 数字取自 release-windows run `37609717113`（tip `fbb3562`）的 `::notice` 行
> （Actions 日志可检索 `wv2-baseline` / `wv2-embedBootstrapper` / `wv2-standalone-*`）。

| 方案 | 体积 | 相对基线增量 | 数据来源 |
|---|---|---|---|
| (a) 基线 downloadBootstrapper x64 | **4.65 MB** | — | `wv2-baseline-x64` |
| (b) embedBootstrapper x64 | 测量步构建未产包（continue-on-error）；按内嵌引导 stub ≈ +1.7 MB 估 | ≈ +1.7 MB（估） | `wv2-embedBootstrapper` |
| (c) Evergreen Standalone x64 | 1.76 MB（curl 命中的是引导 stub，非完整离线包，见下注） | — | `wv2-standalone-x64` |
| (c) Evergreen Standalone x86 | **202.52 MB** | — | `wv2-standalone-x86` |
| (c) Evergreen Standalone arm64 | 0.06 MB（fwlink 在 curl 下返回重定向页，非完整包，见下注） | — | `wv2-standalone-arm64` |

> 注：(c) 中 x86 拿到的 202.52 MB 才是完整 Evergreen Standalone 离线运行时安装器的真实体积；
> x64/arm64 的 fwlink 在无头 `curl -L` 下返回了 stub/重定向级小文件，未能取到完整体积——
> 但 x86 已足以界定「完整离线运行时 ≈ 200 MB」量级。
> (b) embedBootstrapper 仅内嵌约 1.7 MB 的引导 stub，安装时**仍需联网**下载约 200 MB 运行时，
> 因此它不是真正的离线方案。

离线方案总体积增量 ≈ (c) 完整运行时安装器体积（≈200 MB，offlineInstaller 会整个塞进安装包）。

## 4. 判定与结论

判定标准：固定版/离线方案**总体积增量 ≤ 180MB** 且许可证/冒烟可行 → 在 CI 启用并做安装
冒烟；否则保留 downloadBootstrapper，并在用户指南写明「离线 Windows 需先手动装
WebView2 Runtime」。

**最终结论：保留默认 `downloadBootstrapper`，不启用离线内嵌。**

依据（实测）：完整 Evergreen Standalone 运行时约 **202 MB**（x86 实测），offlineInstaller 会把它
整个塞进 NSIS 包，使安装包从 4.65 MB 暴涨到约 **200+ MB**，**超出 180 MB 预算**。
`embedBootstrapper` 只省掉引导 stub 的几 MB，安装时仍要联网下运行时，不解决离线问题。
因此：

- 发版产物维持现状（小安装包，装时联网引导装 WebView2）；
- 未修改 `tauri.conf.json`（`nsis.webviewInstallMode` 保持默认）；
- 完全离线 / 内网隔离的 Windows 机器，需先手动安装 WebView2 Evergreen Runtime
  （官方说明见 `docs/windows-user-guide.md` §4 与
  https://developer.microsoft.com/microsoft-edge/webview2/）。
