# Wave19 C — 更新器无网/异常回退的无头确定性测试缝

## 背景

Wave15 A 给 Windows EXE 接了官方 `tauri-plugin-updater` v2 的**手动**更新器：
用户点「帮助 → 检查更新…」发一次 `check()`，有新版走原生确认对话框 + 下载安装；
无更新 / 离线 / 404（还没有 latest.json）/ 签名或解析错误**一律静默回退**为用
opener 打开 `releases/latest` 网页（Wave13 老行为，不弹错误吓人）。

问题：这条「失败 → 回退网页」的分支只在真实用户点击后发生，发生在带公钥验签的
updater 插件内部，**无法在无头 CI 上驱动**——没法模拟一次真实菜单点击，也没法
让 updater 插件在 CI 里走到它的 Err 分支。Wave19 C 就是给这条回退分支加一条
能在 CI 上确定性测的缝。

## 设计：把决策抽成 tauri-free 纯函数

新模块 `apps/desktop-tauri/src-tauri/src/update_probe.rs`，完全不 import tauri：

```text
一次 GET endpoint ──► FetchOutcome ──► classify(outcome, current) ──► Decision
```

- **`FetchOutcome`**：`Unreachable` / `Timeout` / `HttpResponse{status, body}`。
  把「网络/HTTP 层发生了什么」与「据此该怎么办」分开，纯函数不碰 reqwest 错误类型。
- **`FallbackReason`**：`unreachable` / `timeout` / `http-4xx`（含 404）/
  `malformed-manifest`（200 但不是带 version 字段的清单 JSON）/ `other`（5xx 等）。
- **`Decision`**：
  - `UpdateAvailable{remote,current}` —— 200 + 合法清单 + 远端版本 > 当前；
  - `UpToDate{remote,current}` —— 200 + 合法清单 + 远端版本 ≤ 当前；
  - `FallbackToReleasesPage(reason)` —— 任何被刻意处理为打开 Releases 网页的失败。

`classify` 是纯函数：同输入必同输出（单测里有 `classify_is_idempotent`）。
版本比较是极简数字段元组比较（不引 semver 直接依赖，探针只需要粗判「远端更新」）。

## 两条路径共用同一份分类

- **菜单路径**（`lib.rs::run_manual_update_check`）：updater 插件自己发带验签的
  请求，成功路径（有新版 → Yes/No 对话框 → `download_and_install` → restart）
  **原样保留**；`Ok(None)` 与 `Err(e)` 分支改用 `update_probe::reason_from_error_text`
  把错误文本归类后再 `open_releases_page`。这样菜单走的回退决策就是被单测覆盖的那个。
- **CLI 路径**（`update_probe::probe_cli`）：在 `run()` 最前、builder 之前拦截，
  与 `--diag-export` / `--native-autosave-selftest` 同款。不弹窗、不开 webview、
  不下载不安装；用 `reqwest::blocking::Client`（8s 超时、**绝不重试**）直连参数
  给定的 endpoint，走到决策就退出。

## 隐藏 CLI

```
drawpaper.exe --update-check-probe <endpoint>
```

- 在 Tauri builder 之前拦截：不创建 app handle、不注册插件、不进事件循环。
- 一次 GET、8s 超时、不重试；stdout 打一行稳定可 grep 的 `decision=...`：
  - `decision=update-available remote=<v> current=<c>`
  - `decision=up-to-date remote=<v> current=<c>`
  - `decision=fallback-releases reason=unreachable|timeout|http-4xx|malformed-manifest|other`
- **退出码**：`0` = 检查正常完成并得到一个明确决策（**含** fallback-releases ——
  不可达 / 404 / 畸形清单都是被正确处理的预期结果）；非 0 仅用于缺参数 / 内部故障。

## 零后台红线

与 Wave15 A 的手动更新器一样，这个探针**只能由显式 CLI 或菜单点击触发**：

- 启动时不检查、无定时器、无轮询、无 interval、无自动下载；
- `update_probe::probe_cli` 只出现在 `run()` 的参数拦截分支里；
- 菜单里 `updater.check()` 仍只由 `help:check-update` 事件触发。

> 汇报时 `grep -n "update_probe\|probe_cli" src/lib.rs` 自证：probe 仅出现在
> run() 参数拦截分支与 `run_manual_update_check` 的日志分类里，无任何后台调用点。

## CI 断言（release-windows，x64）

1. **纯函数单测**：既有 `cargo test (x64)` 步骤自动带上新模块的 `#[cfg(test)]`
   用例（unreachable / timeout / 404 / 403 / 503 / 畸形 JSON / 无 version 字段 /
   合法有更新 / 合法同版本 / 合法旧版本 / 幂等 / stdout 行稳定 / 错误文本归类）。
2. **必红冒烟**（插在 NSIS 卸载步骤前）：对安装目录的 `drawpaper.exe` 跑
   `--update-check-probe http://127.0.0.1:1/`（封闭 loopback 端口 = 连接拒绝 =
   unreachable），30s 有界等待，断言：
   - 进程在 30s 内退出（证明不卡死、无弹窗、无 webview 泄漏）；
   - exit code == 0；
   - stdout 含 `decision=fallback-releases`。
   404 / 畸形清单分支由 cargo 单测覆盖（不在 CI 起本地 HTTP server）。

## 与手动更新器的关系

探针**不替代** updater 插件，只是把「失败 → 回退网页」这条决策单独拎出来做
确定性测试。真实发版时 updater 插件仍负责带公钥验签的下载安装；探针只走到
「该打开网页还是该提示更新」这个决策点。密钥未配置（`TAURI_SIGNING_KEY` secret
未加）前，更新器不生效、菜单点击回退网页——探针测的就是这条回退路径。

## 依赖

`reqwest = { version = "0.13", default-features = false, features = ["blocking", "rustls"] }`
是新增的**直接**依赖；reqwest 0.13 已在依赖树里（经 tauri-plugin-updater 间接
引入），这里只打开 `blocking` + `rustls` 两个 feature，不引入新的传递依赖。
