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

> 数字取自最近一次 release-windows run 的 `::notice` 行（在 Actions 日志里可检索
> `wv2-baseline` / `wv2-embedBootstrapper` / `wv2-standalone-*`）。

| 方案 | 体积 | 相对基线增量 | 数据来源 |
|---|---|---|---|
| (a) 基线 downloadBootstrapper x64 | _待填_ | — | `wv2-baseline-x64` |
| (b) embedBootstrapper x64 | _待填_ | _待填_ | `wv2-embedBootstrapper` |
| (c) Evergreen Standalone x64 | _待填_ | — | `wv2-standalone-x64` |
| (c) Evergreen Standalone x86 | _待填_ | — | `wv2-standalone-x86` |
| (c) Evergreen Standalone arm64 | _待填_ | — | `wv2-standalone-arm64` |

离线方案总体积增量 ≈ (c) 运行时安装器体积（offlineInstaller 会把它整个塞进安装包）。

## 4. 判定与结论

判定标准：固定版/离线方案**总体积增量 ≤ 180MB** 且许可证/冒烟可行 → 在 CI 启用并做安装
冒烟；否则保留 downloadBootstrapper，并在用户指南写明「离线 Windows 需先手动装
WebView2 Runtime」。

最终结论：_待 CI 数据回填_。
