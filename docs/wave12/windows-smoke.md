# Wave 12 C 路：Windows 安装包冒烟测试设计

> 对应工作流：`.github/workflows/release-windows.yml` 的 `build` job（matrix x64 / arm64）。
> 目的：每次 `tauri build` 出 NSIS 安装包后，在同一个 Windows runner 上自动跑一遍「资源新鲜 → 静默安装 → 版本核对 → 启动窗口存活 → 静默卸载」的最小闭环，防止「包能出但装不上 / 装上不是这个版本 / 装上起不来」这类回归合进 Release。
> 红线：本设计只加步骤，不改任何源码、`tauri.conf.json`、版本号；不改另外两条 workflow；不 push main、不建 tag。

## 1. 触发

`release-windows` 的 `on.push.branches` 在本波（C 路）新增两个字面量分支：

- `feat/desktop-shell-polish`（A 路并行开发分支，借它触发 Windows CI 验证桌面壳改动）
- `chore/windows-ci-smoke`（本分支）

保留原有的 `develop`、`feat/p2-tauri-ci` 与 `workflow_dispatch`、tag `v*`。**不用通配符**，避免误伤其他 `chore/*` / `feat/*` 分支。

> 第一次提交（`ci(windows): trigger smoke work on desktop/ci feat branches`）只改分支触发列表并先推送，让并行分支立刻能触发 Windows CI；冒烟步骤在第二个提交里加入。

## 2. 冒烟步骤一览（build job，Tauri build 之后、upload-artifact 之前）

| # | step name | 运行架构 | shell | 断言 |
|---|---|---|---|---|
| 1 | `Smoke (both arches): bundled web assets contain a fresh index-*.js` | x64 + arm64 | pwsh | `target/` 递归找到 `index-*.js`，至少一个，且最新一份距现在 ≤ 15 分钟 |
| 2 | `Smoke (x64): silent NSIS install, exe present, ProductVersion matches tauri.conf` | **仅 x64** | pwsh | `/S` 静默安装返回 0；`%LOCALAPPDATA%\drawpaper\drawpaper.exe` 存在；ProductVersion 与 tauri.conf version 归一化后一致 |
| 3 | `Smoke (x64): launch exe, main window title contains drawpaper, then kill` | **仅 x64** | pwsh | 启动后轮询 20s，`Get-Process drawpaper` 存活且 `MainWindowTitle`（小写）含 `drawpaper`；随后 `Stop-Process -Force` |
| 4 | `Smoke (x64): silent uninstall, install dir removed` | **仅 x64** | pwsh | 跑安装目录下 `Uninstall*.exe /S`，轮询 20s 断言安装目录被删除 |

任一 step 非零退出即整个 matrix job 失败（`$ErrorActionPreference = 'Stop'` + PowerShell 非零退出），artifact 不会上传，Release 不会产出。

## 3. 关键设计点

### 3.1 资源新鲜度断言（step 1，双架构都跑）

- 路径：`apps/desktop-tauri/src-tauri/target` 下 `Get-ChildItem -Recurse -Filter 'index-*.js'`。
- 为什么只查文件系统不跑 exe：这一步是架构无关的「打包资源里有没有最新前端产物」校验，arm64 交叉编译也会把前端 hash 化 JS 打进 bundle，所以两架构都能跑。
- 新鲜度阈值 15 分钟：刚 `pnpm -r build` + `tauri build` 完，最新 `index-*.js` 应该就是这一轮产物；超过 15 分钟说明可能打到了缓存里的旧前端，直接判失败。

### 3.2 静默安装路径（step 2）

- 安装命令：`Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru`，断言 `ExitCode -eq 0`。
- `nsis.installMode` 由 A 路设为 `currentUser`，所以安装目录预期 `$env:LOCALAPPDATA\drawpaper`。脚本里再做一次目录发现兜底：`Get-ChildItem $env:LOCALAPPDATA -Filter drawpaper -Directory`，避免未来 installMode 微调导致硬编码路径失配。
- exe 名固定 `drawpaper.exe`；先直拼安装目录，找不到再递归一次兜底。

### 3.3 版本归一化比较（step 2，核心）

分支（非 tag）运行时没有 release tag 名可读，所以**预期版本**从 `apps/desktop-tauri/src-tauri/tauri.conf.json` 读：

```powershell
$expectedVersion = (Get-Content -Raw tauri.conf.json | ConvertFrom-Json).version
```

**实际版本**取安装后 exe 的文件属性：

```powershell
$productVersion = (Get-Item $exe).VersionInfo.ProductVersion
```

Windows 的 `ProductVersion` 字符串会对 pre-release tag 做规范化：`tauri.conf` 里写 `0.1.0-rc.4`，PE 资源块里的 ProductVersion 可能变成 `0.1.0.4`（`rc` 字样被丢弃、revision 位补成 4）。直接字符串相等会假失败，因此做**数值 token 归一化**：

```powershell
function Get-NumTokens([string]$v) {
  return @([regex]::Matches($v, '\d+') | ForEach-Object { [int]$_.Value })
}
$exp = Get-NumTokens $expectedVersion   # "0.1.0-rc.4" -> [0,1,0,4]
$got = Get-NumTokens $productVersion   # "0.1.0.4"     -> [0,1,0,4]
# 短的一侧补 0 对齐长度，再 Compare-Object 必须为空
while ($exp.Count -lt $max) { $exp += 0 }
while ($got.Count -lt $max) { $got += 0 }
```

要点：

- 两边**原值都写进日志**（`tauri.conf version (raw)` / `ProductVersion (raw)`），出问题时人工一眼能看出是不是 Windows 规范化导致的。
- 只比较数字 token（丢掉 `rc`/`alpha`/`beta` 这类字母标签），短侧补 0 对齐，容忍 Windows 追加 build/revision 位。
- 这不是严格语义化版本比较，只是「防止装错版本号的包」的冒烟级护栏；真正的发版版本一致性由 `docs/RELEASE.md §5` 的版本号清单人工兜底。

### 3.4 窗口存活断言（step 3）

- `Start-Process $exe -PassThru` 后轮询最多 20 秒，每秒一次：
  - `Get-Process -Name 'drawpaper'` 必须存在；
  - 其 `MainWindowTitle`（转小写后）必须 `.Contains('drawpaper')`。
- 命中即 `Stop-Process -Force`，并 best-effort 清掉残留 `drawpaper` 进程，避免污染同 job 后续步骤。
- windows-latest runner 带交互式桌面会话，Tauri/WebView2 窗口能起来；如果 20s 内窗口标题始终为空（启动崩溃 / WebView2 运行时缺失），step 失败。

### 3.5 卸载断言（step 4）

- NSIS currentUser 卸载器在安装目录下，命名通常是 `Uninstall drawpaper.exe`。脚本用 `Uninstall*.exe` / `uninstall*.exe` 通配发现，避免空格命名写死。
- `Start-Process -Wait -ArgumentList '/S'` 静默卸载，再轮询 20s 断言安装目录 `Test-Path` 为假。残留文件会列出来进日志，方便定位是哪个文件没被 NSIS 规则清理。

## 4. x64 / arm64 门控结论

- runner 是 `windows-latest`（**x64 物理机**）。arm64 matrix job 只是交叉编译出一个 aarch64 PE，**在 x64 Windows 上无法启动**（Win32 loader 直接拒绝「不是有效的 Win32 应用程序」）。
- 因此：
  - **step 1（资源新鲜度）** 两架构都跑——它只读磁盘，不执行 exe。
  - **step 2/3/4（装、起、卸）** 加 `if: matrix.arch == 'x64'` 门控；在 arm64 job 上 GitHub Actions 会把这些 step 标为 `skipped`（黄色），**不是 `success`（绿色假通过）**。
- 这是客观 runner 限制，不是「arm64 包没问题所以跳过」。等未来有 arm64 托管 runner（或自托管 arm64 机），把门控去掉即可让 arm64 也跑真实装/卸。
- **不允许**在 arm64 上把执行类 step 改成「mock 一下打个 OK 日志」——那样就是假绿。

## 5. publish job 的 SHA256SUMS.txt

- `publish` job（ubuntu，仅 tag）下载两个 artifact 后，新增 `Generate SHA256SUMS.txt` step：
  ```bash
  cd artifacts
  for exe in $(find nsis-x64 nsis-arm64 -name '*-setup.exe' | sort); do
    hash=$(sha256sum "$exe" | cut -d' ' -f1)
    printf '%s  %s\n' "$hash" "$(basename "$exe")" >> SHA256SUMS.txt
  done
  ```
- 用**文件名 basename**（不带 `nsis-x64/` 前缀），这样用户把两个 exe 和 sums 文件下载到同一个目录就能 `sha256sum -c SHA256SUMS.txt` 直接校验。
- `softprops/action-gh-release@v2` 的 `files:` 列表新增 `artifacts/SHA256SUMS.txt`，随两个 exe 一起挂到 Release；Release 正文也加了一行说明。

## 6. 实跑日志位置

- 分支/dispatch 运行（非 tag）：仓库 Actions → `release-windows` → 对应 run → 展开 build / (x64) job → 上述 4 个 `Smoke ...` step。
- tag 发布运行：同上，外加 publish job 的 `Generate SHA256SUMS.txt` step 会打印 sums 内容；最终校验和在 Release 页面的 `SHA256SUMS.txt` 附件里。
- 失败排查顺序：先看 step 2 的 raw 版本两行（判断是不是版本归一化问题）→ 再看 step 3 的逐秒 `MainWindowTitle=` 输出（判断是起不来还是起得慢）→ step 4 的残留文件列表（判断 NSIS 卸载规则漏了什么）。

## 7. 边界与红线

- 本波**不改** `tauri.conf.json`、任何源码、任何版本号；不改 `web-ci.yml` / `android-debug.yml`。
- 不 push `main`、不创建 tag。提交身份 `doubao-dev <dev@doubao.local>`，推到 `chore/windows-ci-smoke`。
- 代码签名（Authenticode）与 Tauri updater 是「未来接入」，见 `docs/RELEASE.md` §9 / §10，本波不实现、不引入任何 secret。
