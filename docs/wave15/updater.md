# Wave15 A — Windows EXE 接入 Tauri 手动更新器

> 分支：`feat/win-updater`（基线 `origin/develop` = 73cf8ad，rc.7 已发布）。
> 本路只做 **Windows 桌面壳的手动更新器接入**；bundle 目标列表（`bundle.targets`）由 B 路在另一分支改，本路不动。

## 1. 它是什么

把「帮助 → 检查更新…」从「用浏览器打开 Releases 网页」升级为**纯用户手动触发**的原生更新流程：

- 用户点「帮助 → 检查更新…」→ Rust 侧用官方 `tauri-plugin-updater` v2 向 GitHub Release 的 `latest.json` 发**一次**检查请求；
- 有新版本 → 原生对话框显示「当前版本 / 最新版本 / 更新说明（latest.json 的 `body`）」，用户点「是」→ 下载安装包、验签、跑 NSIS 安装器并重启；用户点「否 / 取消」→ 什么都不做，留在当前版本；
- **无更新、离线、端点缺失（还没有 latest.json）、未配置签名私钥、检查报错**——一律**透明回退**为原来的行为：用系统浏览器打开 `https://github.com/guzifeng123/drawpaper--freedom/releases/latest`。不弹错误、不吓人。

## 2. 零后台外联红线（硬约束）

> **更新检查仅在用户点击时发生一次网络请求。**

- `Updater::check()` **只**出现在菜单事件处理器 `help:check-update` 分支里（见 `apps/desktop-tauri/src-tauri/src/lib.rs` 的 `run_manual_update_check`）。
- 启动时不检查、**没有定时器 / 轮询 / 后台任务**、不自动下载任何东西。
- `tauri-plugin-updater::Builder::new().build()` 注册插件本身不发起任何网络请求；网络请求只发生在显式 `.check()` 调用时。
- 自查命令（应无任何 setup/timer/interval 命中）：
  ```bash
  grep -rn "updater\|\.check()\|set_interval\|setTimeout\|tokio::spawn\|async_runtime::spawn" \
    apps/desktop-tauri/src-tauri/src/lib.rs
  ```
  唯一的 `spawn` 是菜单点击后 `run_manual_update_check` 起的一次性异步任务，任务里唯一的网络调用就是那次 `.check()`。

## 3. 配置与文件落点

| 文件 | 改动 |
|---|---|
| `apps/desktop-tauri/src-tauri/Cargo.toml` | 新增依赖 `tauri-plugin-updater = "2"`；删除旧的「故意不引入 updater」注释。**`version` 字段未动。** |
| `apps/desktop-tauri/src-tauri/src/lib.rs` | 注册 updater 插件；新增 `run_manual_update_check`；`help:check-update` 改调它。 |
| `apps/desktop-tauri/src-tauri/tauri.conf.json` | **仅**在 `plugins` 下新增 `updater.pubkey` + `updater.endpoints`；**`bundle` 段一字未动**（`bundle.targets` 仍由 B 路改）。`version` 未动。 |
| `apps/desktop-tauri/src-tauri/capabilities/default.json` | 新增最小权限 `updater:default`（不预留额外 granular allow-\*）。 |
| `.github/workflows/release-windows.yml` | (a) `on.push.branches` 白名单加 `feat/win-updater`（仅用于触发冒烟构建）；(b) build 步骤从 secret 读签名私钥、缺失则跳过签名；(c) 产物上传带上 `*.sig`；(d) publish job（仅 tag）生成 `latest.json` 并把 `.sig` + `latest.json` 挂到 Release。 |

`tauri.conf.json` 的 updater 段：

```json
"plugins": {
  "updater": {
    "pubkey": "<公钥，见 §4>",
    "endpoints": [
      "https://github.com/guzifeng123/drawpaper--freedom/releases/latest/download/latest.json"
    ]
  }
}
```

## 4. 签名密钥引导（一次性）

用官方 CLI 生成 minisign 密钥对（本机 Linux 无 cargo 也能跑）：

```bash
npx --yes @tauri-apps/cli@^2.1.0 signer generate --ci \
  --write-keys ~/drawpaper-tauri-updater.key -p ""
```

- **公钥**（公开值，已提交进 `tauri.conf.json` 的 `plugins.updater.pubkey`）：
  ```
  dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEY0RTkwNkFCOUQ4M0YxM0MKUldRODhZT2Rxd2JwOU9kOTZILzlLanJsbEVSWUJCaEJWSmZnUkRjUElyc2VkNjV0VzBtOGpCdTMK
  ```
  密钥 ID（公钥注释里的 hex）：`F4E906AB9D83F130`。
- **私钥**（**严禁入库 / 推送到 GitHub / 打进日志 / 贴进汇报**）：保存在仓库与 worktree **之外**的文件 `~/drawpaper-tauri-updater.key`，权限 `600`。
- 本路生成时**未设口令**（`-p ""`），因此**不需要** `TAURI_SIGNING_KEY_PASSWORD` secret；若日后重新生成带口令的密钥，再补该 secret。

### 用户需手动做的事（MainAgent / 维护者）

1. 打开仓库 **Settings → Secrets and variables → Actions**。
2. 新建 secret：
   - 名字：`TAURI_SIGNING_KEY`
   - 值：把 `~/drawpaper-tauri-updater.key` 文件的**全部内容**（多行，原样）粘贴进去。
3. （仅当私钥设了口令时）再建 `TAURI_SIGNING_KEY_PASSWORD`；本路密钥无口令，**不用建**。

> 注意：这是 **updater 更新签名**（minisign，用来验证更新包有没有被篡改），与 §RELEASE.md §9 的 **Authenticode 代码签名**（Windows SmartScreen 信任）是**两套不同的密钥**，不要混用。

## 5. CI 签名链路（release-windows.yml）

- **build job**（x64 + arm64 矩阵，windows-latest）：
  - 步骤里把 secrets 读进临时环境：`TAURI_SIGNING_KEY` / `TAURI_SIGNING_KEY_PASSWORD`。
  - bash 里 **仅当 `TAURI_SIGNING_KEY` 非空**才 `export TAURI_SIGNING_PRIVATE_KEY[=_PASSWORD]` 给 `tauri build`。
  - secret 缺失（**分支 run 常态**）→ 不 export → `tauri build` 不签名、**不生成 `.sig`，但 `.exe` 照常产出、build 必须 Success**。日志里会打一行 `updater signing: SKIPPED ...`。
  - secret 已配置（tag 发布）→ `tauri build` 自动给每个 NSIS 产物生成同名 `.exe.sig`。
- **产物上传**：`nsis-x64` / `nsis-arm64` artifact 同时收 `*.exe` 与 `*.exe.sig`（`.sig` 在分支 run 上不存在，不影响上传，因为 `.exe` 一定在）。
- **publish job**（**仅 tag push** 跑，分支 run 不跑）：
  - 下载两个 artifact；
  - 生成 `latest.json`（Tauri 静态清单格式：`version` / `notes` / `pub_date` / `platforms."windows-x86_64".{url,signature}` / `platforms."windows-aarch64".{url,signature}`，签名直接读 `.sig` 文件内容）；
  - 把两个 `.exe` + 两个 `.sig` + `latest.json` + `SHA256SUMS.txt` 一起挂到 GitHub Release。
  - 若 `.sig` 缺失（tag 时仍未配 secret）→ 打 warning 并**跳过 latest.json**，安装包照常发布，应用内更新自动回退网页。

> 分支 run 上 publish job 被 `if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')` 挡住，所以 latest.json / `.sig` 的真实产出要到**第一次正式打 tag** 时才会被验证；本路以分支 build job 的双架构真实构建 Success 作为 Rust 正确性依据。

## 6. 未配置密钥前的实际行为（当前状态）

本路合入后、**在维护者把 `TAURI_SIGNING_KEY` 加为 GitHub secret 并打第一个带签名的 tag 之前**：

- 应用里点「帮助 → 检查更新…」→ 拉 `latest.json` 会 404（Release 上还没有这个 asset）→ `check()` 返回 Err → **自动回退**为浏览器打开 Releases 网页，和 rc.7 体验一致。
- 分支 / develop 上的 `release-windows` build **不签名**、不出 `.sig`、不生成 `latest.json`，但两个 NSIS 安装包照常产出、冒烟照常跑、run Success。
- 用户升级方式仍是「去 Releases 页手动下新安装包覆盖安装」。

一旦配好 secret 并打 tag：旧版应用点「检查更新…」即可原生发现新版、对话框确认后下载验签安装并重启。

## 7. 门禁与已知遗留

- 本机 Linux 无 cargo，**不能本地 `cargo check`**；Rust 正确性以分支 `release-windows` 双架构（x64 + arm64）真实构建为最终依据。
- publish job 的 `latest.json` 生成逻辑只在 tag push 触发，本路无法在分支 run 上实跑验证，按 Tauri 2.1 静态清单格式编写，待首个签名 tag 验证。
- `bundle.targets` 本路未动（B 路在另一分支改）。
