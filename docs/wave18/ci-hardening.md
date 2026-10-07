# Wave18：EXE CI 收尾加固（release-windows）

分支 `chore/ci-exe-hardening`（基线 0ef0ff5 / rc.9）。范围仅限
`.github/workflows/release-windows.yml`、`apps/desktop-tauri/ci/*.ps1`、`docs/wave18/*`、
`CHANGELOG.md`；不改产品代码、不动版本号、不打 tag。

## P1（必做，已接，必红）：native-autosave selftest 接 CI

新增唯一名步骤 **`Smoke (x64): native-autosave headless selftest (mirror files + traversal rejection)`**，
插在 diag 金丝雀之后、NSIS 卸载冒烟之前（此时 NSIS 安装版 exe 已就位）。

判定逻辑（全部硬断言，任一不过即 Write-Error 判红）：

1. 复用既有四候选数组发现安装目录与 `drawpaper.exe`；
2. 唯一 temp dir（`%TEMP%\dp-selftest-<guid>`）；
3. GUI 子系统 exe 与 diag 金丝雀同款捕获：`cmd /c "exe --native-autosave-selftest <dir>" > log 2>&1`，
   `Start-Process -PassThru` 有界等待 60s（超时强杀并判红）；
4. **run 1**：exit code = 0；捕获日志含 `selftest OK`；
   - `selftest-doc.kbnote` 存在且**逐字节**等于 `{"format":"knowledge-block-notes","version":4}`；
   - `assets\abc123def` 存在且字节数=16、内容逐字节等于 `FAKE-ASSET-BYTES`；
   - temp dir 内**无 `evil*.kbnote`**，且 temp dir 父目录近 5 分钟内也**无 `evil*.kbnote`**
     （覆盖 `../evil.kbnote` 穿越落点的防御性断言——join_within 拒绝后绝不该有文件写出）；
5. **run 2（同目录重跑）**：exit code = 0 且日志含 `selftest OK`——幂等（覆盖写不报错）；
6. 清理 temp dir 与日志。

## P2（必做，已加严）：NSIS 卸载最后一级兜底

修改 `Smoke (x64): silent uninstall, install dir removed`（只加严不放宽）：

- 维持既有：`/SILENT` → `/S` 两轮卸载器进程等待 + 目录 20s 轮询；
- **新增**：两轮跑完目录仍在时，先打印剩余文件清单（pre-sweep），再
  `Get-Process` 里 `drawpaper*` / `unins*` / `uninstall*` 一次性 `Stop-Process -Force`
  （逐个打印 kill 动作），睡 2s，再**轮询 10s** 复查；
- 复查仍在 → 打印最终剩余清单并 `Write-Error` 判红（真失败依然红）；复查消失 → OK。
- 目的：消化 Wave15 在高负载 runner 上因残留进程占用句柄导致的一次偶发假红；
  兜底只在「已失败路径」上尝试恢复，不影响成功路径。

## P3（必做，调研结论）：ARM64 hosted runner 评估

详见 [`arm64-runner-assessment.md`](./arm64-runner-assessment.md)（含全部来源 URL 与查询日期 2026-10-08）。
摘要：`windows-11-arm` 对公开仓库 2025-08-07 起 **GA、免费**（4 vCPU/16GB，镜像自带 Node22 缓存、
Rust、VS2022 ARM、NSIS 3.10；**缺 WiX**）。本仓库为公开仓库，技术上已可升级 arm64 实跑；
但本分支**不加任何 arm64 实跑 job**，维持「arm64 仅交叉构建」现状，升级留待独立波次
（建议优先把 P1/`--diag-export` 两个 headless CLI 冒烟放开 arm64 条件，约 0.5–1 天）。

## P4（时间盒，各一次尝试）：更新器无网回退 / 诊断菜单 UI 弱断言

两个脚本均已写好并以 **`continue-on-error: true`** 接入（失败只琥珀不阻断，日志充分，
绝不假绿）；脚本内对前置条件缺失打印明确 `::SKIP::`。

### a. 更新器无网回退 —— `apps/desktop-tauri/ci/updater-offline-fallback.ps1`（已接，continue-on-error）

- 做法：New-NetFirewallRule 仅对 `drawpaper.exe` 进程出站 Block（finally 必删）→
  启动应用等主窗口 → SendKeys `Alt → Right×5 → Down → Enter`（帮助→检查更新…）→
  30s 内有界等待双证据：
  ① `%APPDATA%\com.drawpaper.app\logs\drawpaper.log` 出现锚点
  `falling back to Releases web page`（对应 lib.rs `run_manual_update_check` 的两条 warn：
  updater build failed / check() Err）；
  ② 浏览器进程命令行含 `releases/latest`（opener 真的打开了 Releases 页）；
  ③ 进程不崩。
- 风险与挂账说明：SendKeys 依赖原生菜单与窗口焦点，hosted runner 桌面会话下可能点空；
  一次实跑后若琥珀稳定，维持现状观察不追 flaky。**手动验证步骤**：
  1. 装 rc.9 NSIS 版后以管理员开 PowerShell；
  2. `New-NetFirewallRule -DisplayName t -Direction Outbound -Program "$env:LOCALAPPDATA\Programs\drawpaper\drawpaper.exe" -Action Block`；
  3. 启动 drawpaper，菜单「帮助 → 检查更新…」；
  4. 预期：不弹窗报错、进程不崩、默认浏览器打开 `releases/latest`，drawpaper.log 含回退行；
  5. `Remove-NetFirewallRule -DisplayName t`。

### b. 诊断菜单 UI —— `apps/desktop-tauri/ci/diagnostics-menu-ui.ps1`（已接，continue-on-error）

- 做法：启动应用 → SendKeys `Alt → Right×5 → Down×4 → Enter`（帮助→导出诊断信息…）→
  原生保存对话框出现后直接 SendKeys 输入 `%TEMP%\dp-diag-menu-<guid>.zip` + Enter →
  40s 内等 zip → Expand-Archive 断言含 `system.json`、**零 `*.kbnote` 条目**。
- 风险与挂账说明：原生保存对话框焦点/标题在 runner 上不可控；点空即 40s 超时 exit 1（琥珀）。
  无头 CLI `--diag-export` 金丝雀已在 CI 必红覆盖同一路径的隐私断言，本步骤只是补 UI 入口回归。
  **手动验证步骤**：帮助→导出诊断信息… → 另存对话框选桌面 → 打开 zip 确认含 system.json 且无 .kbnote。

## 冲突面与红线自检

- 冲突面：本分支改 `release-windows.yml` 与 `CHANGELOG.md`——与 develop 上后续波次同文件，
  合入时按步骤文本机械合并（P1 插在 diag 金丝雀后、卸载前；P2 只动卸载步骤尾部；P4 插在 P1 后卸载前）。
- 红线：仅 yaml / ps1 / docs / CHANGELOG 四类文件；无版本号 diff、无 tag、无 develop/main 推送；
  既有冒烟步骤一条未删未放宽（P2 为加严）；CHANGELOG 只加「## 未发布（Unreleased）」段。
