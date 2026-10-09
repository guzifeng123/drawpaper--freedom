# Wave24 路1 — 原生 EXE 体积与冷启动测量基线 + 白屏消除

对 `fix/native-binary-startup` 分支做的「先加测量基线、再逐项优化、同口径 before/after」实验。
所有结论均来自 release-windows CI 实测（匿名 run 页 annotations），无本地臆测。

## 时间盒与 run 矩阵

| run | head | 内容 | 结果 |
|-----|------|------|------|
| 1 | `98ee9dd` | 纯测量基线（不改任何功能/版本） | build x64+arm64 ✅ / arm64-native ✅ / publish skipped |
| 2 | `9da6046` | 窗口修复尝试①：`WindowEvent::Ready` | **编译失败**（该变体在 tauri 2.12 不存在） |
| 3 | `8ff7454` | 窗口修复尝试②：`WebviewWindow::on_page_load` | **编译失败**（该方法 2.12 尚未提供，dev 分支才有） |
| 4 | `079826a` | 窗口修复终版：前端 `reveal_window` + Rust 安全网 | build x64+arm64 ✅ / arm64-native ✅ / publish skipped |

> run 2/3 的编译失败本身是有效负结果：它们证伪了「Rust 侧一个事件回调就能 reveal」的
> 直觉——tauri 2.12 对 conf 声明的窗口**既无 `WindowEvent::Ready` 也无 `on_page_load`**。

## 测量方法（同口径）

在 `release-windows.yml` build job 新增三步（纯新增，未改既有断言）：

1. **`Measure (w24): bundle artifact exact bytes`**（双架构）：扫 `target/**/bundle`，
   打印每个 `*-setup.exe` 与 `*.msi` 的**精确字节数**（替代 Wave15 Measure(a) 的 MB 四舍五入）。
2. **`Measure (w24): installed footprint + cold-start to window`**（x64，NSIS 静默安装后）：
   - 安装目录递归总字节数 + `drawpaper.exe` 字节数；
   - 冷启动 **7 次采样**：每次先杀干净 drawpaper 及其 WebView2 子进程，
     `Stopwatch` 从 `Start-Process` 起，50ms 轮询到 `MainWindowHandle != 0 && MainWindowTitle`
     含 `drawpaper`（沿用既有冒烟的窗口等待手法），单次硬上限 30s；
     取中位数/min/max + 采样原始值 + 平均 PrivateMemorySize。
   - 测量只打印数据、不做阈值门；但任一采样 30s 内不出现窗口即 `Write-Error` 转红
     （这同时是启动回归守卫）。
3. **`Measure (w24): cargo dep feature audit`**（x64，informational）：`cargo tree` 与
   `cargo tree -i reqwest/hyper/rustls/ring/brotli`，只喂优化决策。

## before / after 数据

### 安装包字节

| 产物 | before (run1) | after (run4) | Δ |
|------|--------------:|-------------:|---:|
| NSIS setup.exe x64 | 5,568,454 B | 5,569,863 B | +1,409 B (+0.03%) |
| NSIS setup.exe arm64 | 5,367,141 B | 5,368,581 B | +1,440 B (+0.03%) |
| MSI x64 en-US | 6,483,968 B | 6,488,064 B | +4,096 B (+0.06%) |
| MSI x64 zh-CN | 6,483,968 B | 6,488,064 B | +4,096 B (+0.06%) |
| MSI arm64 en-US | 6,361,088 B | 6,365,184 B | +4,096 B (+0.06%) |
| MSI arm64 zh-CN | 6,361,088 B | 6,365,184 B | +4,096 B (+0.06%) |

窗口时机改动不改依赖、不改 profile，二进制字节数零实质变化（+0.03~0.06% 纯属
reveal_window command + 前端 invoke 的重编译噪声）。

### 安装后占地（x64）

| 指标 | before (run1) | after (run4) | Δ |
|------|--------------:|-------------:|---:|
| 安装目录总字节 | 9,465,859 B | 9,471,516 B | +5,657 B (+0.06%) |
| drawpaper.exe 字节 | 9,379,840 B | 9,385,472 B | +5,632 B (+0.06%) |

### 冷启动到主窗口（x64，7 采样中位数）

| 指标 | before (run1, visible:true) | after (run4, visible:false) | Δ |
|------|----------------------------:|----------------------------:|---:|
| 中位数 | **77 ms** | **68 ms** | -9 ms (-12%) |
| min / max | 63 / 145 ms | 59 / 129 ms | -4 / -16 ms |
| 原始采样 | 63/70/70/77/82/82/145 | 59/65/65/68/68/71/129 | — |

**口径说明（重要）**：before 时窗口默认 `visible:true`，`MainWindowHandle` 在原生窗口框
一创建就非零——77ms 量到的是「空白原生框出现」，其后还有一段白屏才到 React 首帧。
after 时窗口 `visible:false`，`MainWindowHandle` 直到前端 `reveal_window`（React 挂载后、
双 rAF）才非零——量到的是「真正画好的窗口出现」。两者用同一轮询、同一阈值。实测 after
中位数 68ms（比 before 还快 9ms）：在这台热 runner 上 React 首帧足够快，reveal 一触发窗口
即已渲染，**用户不再先看到空白框再换内容**——白屏闪烁消除，且窗口出现时刻不劣化。

## 白屏修法

- `tauri.conf.json` `app.windows[0].visible = false`（仅此一项；未碰 `bundle.windows.webviewInstallMode`，
  那是路2 `feat/webview2-bootstrapper-embed` 的领地）。
- Rust `setup()` 起一个**安全网**：1.5s 后无条件 `show()+set_focus()`，保证窗口永远不会
  因为前端没回调而一直隐藏。
- 前端 `packages/web/src/main.tsx` 在 React 挂载并双 `requestAnimationFrame` 后，经
  `window.__TAURI__.core.invoke('reveal_window')` 提前 reveal（赢那个 race）。
- 新增 `reveal_window` command（Rust 侧 `show()+set_focus()`，幂等）。
- 为什么不用事件回调：见 run 2/3 负结果——2.12 无此 API。

## argv / 既有行为零回归证据

run4 全绿，以下既有冒烟全部通过（未删未放宽）：
- single-instance：二次启动被吸收，进程数恒为 1；
- 冷启动双击 `.kbnote`：canary 落 log + recents；
- **冷启动 open-file 10/10**（Wave17 StartupQueue 有界重发泵零丢失）；
- first-run welcome doc 落地 leveldb、二次启动不重建；
- global-shortcuts 注册日志锚点；
- native-autosave headless selftest（镜像文件 + 穿越拒绝）；
- update-check-probe 不可达端点回退不挂；
- NSIS/MSI（en-US + zh-CN）静默安装/卸载、.kbnote 关联、快捷方式。

窗口延迟 show 不影响上述：open-file 泵在 `setup()` 里 emit 到 webview，与可见性无关；
webview 监听在 React 挂载时注册，独立于 `show()`。

## 依赖审计结论（无收益项如实列出）

- `[profile.release]` 已激进：`panic="abort"` + `codegen-units=1` + `lto=true` +
  `opt-level="s"` + `strip=true`。**未为改而改**（时间盒内未再试 `lto="fat"`/`opt-level="z"`，
  因现状已是体积最优组合，且任务书明令 profile 禁止为改而改）。
- `reqwest / hyper / rustls / ring / brotli` 虽在依赖树，但 `cargo tree -i` 显示它们由
  **`tauri` 核心自身**（asset/http 协议）+ `tauri-plugin-updater` 拉入——删 updater 插件
  也去不掉 reqwest（tauri 核心依赖），故无裁剪空间。
- 既有裁剪已到位：`reqwest` 早已被 Wave19 移除（改 `std::net`）；`tokio` 仅 `["sync"]`；
  `zip 2` 已 `default-features=false +deflate`（诊断包用，保留）；`tauri` 仅 `["protocol-asset"]`。
- 结论：本路**无可安全裁剪的重依赖**，体积收益主要来自「不再膨胀」而非「再减」。

## 红线自检

- 版本零 diff：`tauri.conf.json` / `Cargo.toml` / package 的 version 字段未动（仍 `0.1.0-rc.15`）。
- 未碰 `bundle.windows.webviewInstallMode`（tauri.conf 仅动 `app.windows[0].visible`）。
- 冒烟零删除：release-windows.yml 纯新增测量步骤，既有断言一条未放宽/删除。
- `continue-on-error` 未新增：仅维持 Measure(b)/(c) 既有 2 处；新增 cargo 审计步骤靠脚本内
  `|| echo` + 无 `set -e` 自兜底，不挂 `continue-on-error`。
- 只推 `fix/native-binary-startup`；未碰 develop/main/tag。
