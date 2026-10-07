# Wave18 — 便携模式冒烟接入 release-windows

把既有的 `apps/desktop-tauri/ci/smoke-portable.ps1`（Wave16-I 留下、从未在 CI 实跑过的自包含脚本）扩展为三组用例，并作为一个新的 x64 步骤接入 `release-windows.yml`，位置在「NSIS 静默卸载」步骤之前（此时 NSIS 已装在安装目录、`drawpaper.exe` 与 `*-setup.exe` 都可用）。

## 三组用例

每组用例独立临时树（`%TEMP%\drawpaper-portable-smoke-<8位hex>\`），用例之间互不共享状态。

### a. marker 触发 + 隔离

1. 拷贝 `drawpaper.exe` 到新临时树，旁边放空文件 `drawpaper.portable`。
2. 快照 `%APPDATA%\com.drawpaper.app` 与 `%LOCALAPPDATA%\com.drawpaper.app` 的存在性与文件数。
3. **先 `Stop-AllDrawpaper` 杀掉所有残留 `drawpaper.exe`**（单实例插件按 app 标识全局命名，前序 CI 步骤若残留一个系统安装版进程，会把我们的便携启动吸收进已有实例、便携 exe 立即退出且不落 `./data`——这是头号 flaky 源，故每次启动前都清场）。
4. 启动便携 exe，**有界轮询**（上限 `WaitSeconds*2` = 30s）等待 `.\data\logs\drawpaper.log` 出现。
5. 日志出现后再给 `WaitSeconds`（15s）有界等待 recents/window-state/EBWebView 落盘，**仅记录不阻断**——这几个产物落盘时机不一（window-state 只在关闭时写、EBWebView leveldb 懒初始化、recents 仅在打开文件时写），硬要求会 flaky；真正证明重定向的是下一步"系统 AppData 不增长"。
6. 断言系统 AppData **未被本次运行新建**（若运行前已存在，则断言文件数不增长——CI 上安装版已被前面的冒烟跑过，目录必然存在，走文件数对比分支）。

### b. data/ 目录触发

1. 新临时树，拷贝 exe，**不放 marker**，只预建空的 `data\` 目录。
2. 同 a 的清场、轮询与断言——证明「已存在可写 data/」也是合法触发器，与 marker 等价。

### c. 覆盖安装不影响便携数据

1. 新临时树（带 marker），清场后启动一次并等到 `.\data\logs\drawpaper.log` 落盘 + 至少一个 recents/window-state/EBWebView，优雅关闭 + 杀进程（含临时树下的 `msedgewebview2` 子进程）。
2. 记录 `.\data\` 下全部文件的相对路径与大小（期望集）。
3. 杀掉所有 `drawpaper.exe` 进程后，对系统安装版再跑一次同版本 NSIS 静默安装（`setup.exe /S /CURRENTUSER`，有界 120s 等待退出，断言 exit code 0）。
4. 再次清场并启动**同一棵**便携树。**先记录重装前 `drawpaper.log` 的字节数与 mtime**，再有界轮询（30s）证明第二次进程存活**且日志字节数/mtime 增长**——即新进程真的又往 `.\data\logs\` 写了一行；仅"日志还在 + 进程活着"会在启动瞬间立即成立，无法区分便携模式是否仍被识别。
5. 断言：
   - 步骤 2 记录的每个文件在重装后**仍然存在**（便携数据不被系统安装器波及）；
   - 第二次启动后系统 AppData 文件数不增长（便携模式仍被识别、未回退系统目录）。

> 用例 c 依赖 `-SetupExePath` 参数；若在 CI 里找不到 `*-setup.exe`（理论上不会发生——构建刚产出），脚本自动 SKIP 该用例并打印 notice，**不假绿**。本批 CI 中安装器可得，故未降级为「卸载再重装」。

## 判定标准

| 用例 | 硬断言 | 说明 |
|---|---|---|
| a | `.\data\logs\drawpaper.log` 30s 内出现；系统 Roaming/Local AppData 未新建且文件数不增长 | recents/window-state/EBWebView 仅记录不阻断；任一硬断言不过即 exit 1 |
| b | 同 a（无 marker、仅预建空 data/ 路径） | 同上 |
| c | 重装 exit code 0；重装后原 data 文件全部存在；第二次启动进程存活且 `drawpaper.log` 字节/mtime 增长；系统 AppData 不增长 | 日志增长是"便携仍被识别"的直接证据 |

任一硬断言失败 → `exit 1` + 打印整棵临时树与系统 AppData 树的诊断清单。

## 清理策略

- **进程清理**：每个用例的 `try/finally` 里先 `CloseMainWindow()` 优雅等 5s（让 WebView2 flush leveldb），再 `Stop-Process -Force`；随后按便携 exe 路径 sweep 同名 `drawpaper.exe` 残留，并额外 sweep 路径位于本临时树之下的 `msedgewebview2.exe` 子进程（避免 leveldb 句柄锁住临时树；其它 runner/步骤的 webview2 进程不在本树内、不动）。脚本末尾再做一次全局 `Stop-AllDrawpaper`（按进程名 `drawpaper`），**双保险**，确保后续 NSIS 卸载步骤不会被「files in use」卡住。
- **每次启动前清场**：单实例插件按 app 标识全局命名，每次便携启动前 `Stop-AllDrawpaper`，保证本用例是唯一实例（详见用例 a 第 3 点）。
- **临时树**：默认用例结束即 `Remove-Item -Recurse -Force`，最多重试 5 次（EBWebView leveldb 句柄可能延迟释放）；`-Keep` 开关保留树供手动检查（进程照杀）。
- **为什么不影响后续卸载/MSI**：临时树全在 `%TEMP%` 下，与 NSIS 安装目录（`%LOCALAPPDATA%\Programs\drawpaper` 或 `Program Files\drawpaper`）物理隔离；步骤末尾全局杀进程保证卸载器启动时无残留 `drawpaper.exe` 占用文件。

## 手动运行

```powershell
# 只用例 a+b（不需要 setup.exe）
powershell -ExecutionPolicy Bypass -File .\apps\desktop-tauri\ci\smoke-portable.ps1 `
    -ExePath 'C:\path\to\drawpaper.exe'

# 三用例全跑（c 需要同版本 setup.exe）
powershell -ExecutionPolicy Bypass -File .\apps\desktop-tauri\ci\smoke-portable.ps1 `
    -ExePath 'C:\path\to\drawpaper.exe' `
    -SetupExePath 'C:\path\to\drawpaper_0.1.0-rc.9_x64-setup.exe' `
    -Keep   # 保留临时树手动检查
```

CI 里由 `release-windows.yml` 自动传入安装目录发现的 exe 与构建产物 `*-setup.exe`，无需手工干预。

## 稳定性分析（为什么不 flaky）

1. **所有等待都是有界轮询**，无裸 `Start-Sleep -Seconds $N` 死等：
   - 日志落盘：每秒探一次 `Test-Path drawpaper.log`，上限 30s，每 5s 打印一次进度。
   - recents/window-state/EBWebView 落盘：日志出现后再宽限 15s 有界探一次。
   - 安装器退出：每秒 `$p.HasExited`，上限 120s。
   - 第二次启动写盘：每秒比 `drawpaper.log` 的字节数/mtime，上限 30s。
2. **日志插件定期 flush**：`drawpaper.log` 由 Tauri 日志插件在启动后很快打开写入，不依赖优雅关闭；即使 `Stop-Process -Force` 也不影响第一次断言（日志已在轮询窗口内落盘）。
3. **单实例清场**：每次便携启动前 `Stop-AllDrawpaper`，杜绝前序步骤残留进程把便携启动"吸收"成空跑——这是本用例最容易假失败的点，用主动清场而非祈祷前序步骤已杀干净。
4. **进程清理双保险 + 子进程 sweep**：`try/finally` 内 per-case 清理（含本树 msedgewebview2）+ 脚本末尾全局 `Stop-AllDrawpaper`，避免残留进程锁住临时树或阻塞后续卸载。
5. **隔离判定用文件数差分而非存在性**：CI runner 上系统 AppData 早已被前面的冒烟步骤写满，硬判「目录不存在」会误报；改为「运行前后文件数不增长」，对便携模式泄漏敏感、对系统目录既存内容鲁棒。
6. **临时树用 GUID 命名**：每次跑互不干扰，跨用例无状态。
7. **不使用 `continue-on-error`**：任何硬断言失败立即 `exit 1`，步骤变红；用例 c 若 setup.exe 缺失则显式 SKIP 并在日志 notice 说明，不会伪装成通过。
