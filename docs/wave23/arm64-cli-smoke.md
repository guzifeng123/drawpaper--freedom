# Wave23 E — arm64-native CLI 冒烟：把 headless CLI 断言抽成跨架构共享脚本

把 `release-windows.yml` 里 x64 build job 内联的 `--diag-export` 隐私金丝雀断言，
抽成**跨架构共享脚本** `apps/desktop-tauri/ci/smoke-cli.ps1`；x64 build job 改为调用
该脚本，`arm64-native` job（`windows-11-arm`）在「静默安装」之后、「卸载」之前
插入同一脚本的调用（`-Arch arm64`），从而把 arm64-native 从「仅装 / 启窗口 / 卸」
升级为也覆盖 headless CLI 面。

## 为什么抽成共享脚本

`drawpaper.exe` 是 GUI 子系统二进制，但在构建任何 Tauri 插件之前拦截了三条隐藏
headless CLI（见 `src-tauri/src/lib.rs::run`）：`--diag-export <zip>`、
`--native-autosave-selftest <dir>`、`--update-check-probe <endpoint>`。这些命令不弹窗、
不开 webview、发完即退出，天然适合无头冒烟。原先只有 x64 交叉构建跑完后才内联跑
`--diag-export` 金丝雀；原生 arm64 runner 上从未执行过任何 headless CLI。把断言抽成
共享脚本后，同一份断言在两种宿主上跑，避免「x64 绿、arm64 裸奔」的覆盖缺口。

## 脚本契约 `apps/desktop-tauri/ci/smoke-cli.ps1`

自包含、不读 CI 环境变量（但失败时发 `::error title=smoke-cli[<arch]>::` 注释，让
匿名 run 页也能看到原因）。参数：

- `-ExePath <path>`（ByPath）**或** `-InstallDir <dir> [-ExeName drawpaper.exe]`（ByDir）
- `-Arch <label>`：自由文本标签，仅用于日志与注释（`x64` / `arm64`）
- `-WaitSeconds`：headless 调用有界等待预算，默认 60s

判定：`$ErrorActionPreference='Stop'`，任一硬断言不过即 `exit 1`；
**不用 try/catch 吞错**（清理用 `try/finally`，finally 只负责兜底 kill，不改变判定）。

封装的断言集合（四条，逐条对应任务书）：

| # | 断言 | 做法 |
|---|---|---|
| ① 版本 | 运行中的 exe 报告的版本 == tauri.conf 版本 | (a) exe 文件 `ProductVersion` 数字 token 序列 == `tauri.conf.version`；(b) headless 跑产出的 `system.json.version`（`env!("CARGO_PKG_VERSION")`）数字 token == `tauri.conf.version`。Windows 会把 `0.1.0-rc.14` 改写成 `0.1.0.14`，故只比数字 token 序列、短侧补 0。 |
| ② 用法关键字 | headless 调用退出 0 且输出含预期用法标记 | app 没有交互式 `--help`（GUI app，仅隐藏 headless 钩子）；等价做法是断言捕获到的 stderr 含处理器自识别标记 `[diag-export]`，证明 CLI 真的 dispatch 到了 headless 分支并打印了用法行。退出码 0 单独断言。 |
| ③ 无窗口生命周期 | headless 调用自行退出、不留进程 | `cmd /c "..." > log 2>&1` 外层引号包裹（Wave18 验证过的写法）启动，有界轮询 `WaitSeconds`；超时则在 `finally` 里强杀并**判红不放宽**（headless CLI 不退出 = 漏了窗口/对话框/webview）。结束后再扫一次，若仍有 `drawpaper` 进程则判红。 |
| ④ diag 金丝雀 | 产出诊断 zip，且 zip 内零 `*.kbnote` / `assets/` | 在 `%APPDATA%\com.drawpaper.app` 埋 `SECRET-canary.kbnote` + `assets/img.png`（正文=唯一秘密串）；跑 `--diag-export <zip>`；断言 exit 0、产出真实 ZIP（PK\x03\x04 头）；展开后断言：无任何 `*.kbnote` 条目、无任何 `assets/` 条目、秘密串在全部文件中零命中；`system.json` 含非空 `version`/`arch` 与 `webview2_runtime_version` 字段；`files-manifest.json` 每个条目恰好 `name/size/mtime` 三字段。与原 x64 内联金丝雀**同源同强度**。 |

> 关于 ①/② 的「等价」：任务书原文写 `--version` / `--help`，但本 app 故意不提供这两个
> 公开子命令——未知 argv 会直接 fall-through 到 Tauri 构建、拉起 GUI 窗口（恰恰违反
> 断言 ③）。脚本取其「等价版本子命令」：`--diag-export` 产出的 `system.json.version`
> 就是运行中二进制自报的版本；其 stderr 的 `[diag-export]` 行就是用法自识别。
> 这比单独跑一个不存在的 `--version` 更能证明「装在这台机器上的这个 exe 版本正确、
> CLI 分支真的被走到」。

## 两 job 步骤对照

### x64 build job（`windows-latest`，matrix x64 行）

原内联步骤 `Smoke (x64): --diag-export privacy canary (no .kbnote/asset leak)`
（约 116 行 pwsh）**整体替换**为：发现安装目录/exe → `& apps/desktop-tauri/ci/smoke-cli.ps1 -ExePath $exe -Arch x64`。
新步骤名 `Smoke (x64): headless CLI suite (version / usage / lifecycle + diag privacy canary)`。
断言集合**只增不减**：保留金丝雀全部子断言，另加 exe ProductVersion 与
system.json.version 双路版本比对。其余 x64 冒烟（NSIS 7+ 断言、MSI 5 步、portable、
`--native-autosave-selftest`、`--update-check-probe`、卸载兜底）**一行未动**。

### arm64-native job（`windows-11-arm`）

在既有「启动 exe、主窗口标题含 drawpaper、然后 kill」步骤之后、「静默卸载」步骤之前，
插入新步骤 `Smoke (arm64 native): headless CLI suite (...)`：发现原生安装目录/exe →
`& apps/desktop-tauri/ci/smoke-cli.ps1 -ExePath $exe -Arch arm64`。窗口标题那步保留现状
（它不是 GUI 交互冒烟）。arm64-native **不上传任何 release 资产**（`publish` 仍只
`needs: build`，发交叉构建产物）。

## 编排不变量

- `build` job 无 `needs`；`arm64-native` job 无 `needs`；`publish.needs` 仍只有 `build`；
  `publish.if` 仍为 tag 触发。本分支 push 触发的一轮里 `publish` 按预期 skipped。
- push 白名单新增精确分支名 `chore/arm64-cli-smoke`（非 glob）。
- 版本零 diff：`tauri.conf.json` / `Cargo.toml` / `Cargo.lock` / `package.json` 未改。

## 每轮 release-windows run 记录

| 轮次 | run id | build (x64) | build (arm64 交叉) | arm64-native | publish | 结论 |
|---|---|---|---|---|---|---|
| 1 | 待填 | 待填 | 待填 | 待填 | 待填（预期 skipped） | 待填 |

## 挂账项

（暂无——若某条断言在 `windows-11-arm` 上因宿主能力缺失无法通过，在此附失败证据
`::error` annotation / step 日志链接后挂账；x64 断言不得挂账。）
