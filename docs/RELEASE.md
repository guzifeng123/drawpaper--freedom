# 发布操作手册（RELEASE）

> 本手册面向维护者：在 develop 合并、CI 全绿之后，如何打 tag 触发发布、产物落在哪、以后发版要改哪些文件、以及出问题如何回滚。
> 当前版本：**0.1.0-rc.4**（预发布 / Release Candidate）。

## 1. 何时打 tag

- 前置：要发布的 commit 已合入 `develop`，且该 commit 在 GitHub 上的 `web-ci` / `release-windows`(build) / `android-debug` 三条 workflow 均为绿色。
- `chore/*`、`feat/*`、`fix/*` 分支本身不触发云端 workflow；只有合到 `develop` 并在 develop tip 跑绿后，才以 develop tip 的 commit 为基线打 tag。
- 本次（RC）约定 tag 为 `v0.1.0-rc.4`。正式版将为 `v0.1.0` / `v1.0.0` 等（不含 `-`）。

## 2. 打 tag 与推送

```bash
# 1) 切到要发布的 commit（通常是 develop tip）
git checkout develop
git pull --ff-only
git log --oneline -1          # 确认这是已跑绿的那个 commit

# 2) 打带注释的 tag（annotated tag）
git tag -a v0.1.0-rc.4 -m "drawpaper 0.1.0-rc.4 (pre-release)"

# 3) 只推这一个 tag（不要用 git push --tags，避免误推其他临时 tag）
git push origin v0.1.0-rc.4
```

推送 tag 后，`release-windows` 的 `publish` job 只在 `github.ref` 以 `refs/tags/` 开头时才会跑；分支 push / 手动触发只验证出包，不创建 Release。

## 3. 触发后三条 workflow 各做什么

| workflow | 触发 | 行为 |
|---|---|---|
| **web-ci** | push / PR 到 develop、PR | 不随 tag 重跑（tag push 不在其触发分支列表）；它是合 develop 前的守门，已在 develop tip 跑绿。 |
| **release-windows** | push tag `v*`（也监听 develop、`feat/p2-tauri-ci`、workflow_dispatch） | 两个 matrix job（windows-latest）并行构建 NSIS 安装包并各自上传 artifact `nsis-x64` / `nsis-arm64`；`publish` job（ubuntu）在两 build 成功后，用 `download-artifact@v4` 分别取回两个目录，再用 `softprops/action-gh-release@v2` 创建 **GitHub Release 并标记为 prerelease: true**，把两个 `.exe` 挂上去。 |
| **android-debug** | push 到 develop / `feat/**` / `fix/**`、PR | **不会随 tag 重跑**（tag 不在其触发分支列表）。它在每次 develop push 时产出一个未签名 debug APK 的 workflow artifact（保留 14 天），**不进 GitHub Release**。 |

> 说明：tag push 本身只直接触发 `release-windows`。`web-ci` 与 `android-debug` 对 tag push 不响应，这是设计如此——它们的产物（测试报告、debug APK）不属于 Release 交付物。

## 4. 产物清单

### 4.1 GitHub Release 上的 Windows 安装包

版本号取自 `tauri.conf.json`（本版 `0.1.0-rc.4`），Tauri NSIS 产物命名规则为 `{productName}_{version}_{arch}-setup.exe`，因此本版：

- `drawpaper_0.1.0-rc.4_x64-setup.exe` — 64 位 Intel/AMD（Win10/11）
- `drawpaper_0.1.0-rc.4_arm64-setup.exe` — ARM64（Copilot+ PC、Surface Pro X 等）

这两个文件由 `publish` job 从 `artifacts/nsis-x64/**` 与 `artifacts/nsis-arm64/**` 通配收集并挂到 Release。NSIS 构建在 Windows runner 上完成；Linux/macOS 无法本地复现该产物。

### 4.2 Android APK 为什么不在 Release

`android-debug.yml` 用 CI 临时 `npx cap add android` 生成工程、`gradlew assembleDebug` 产出 **未签名** 的 `app-debug.apk`，并以 workflow artifact（名 `drawpaper-android-debug`，保留 14 天）形式留存。它**没有签名密钥、不上架、也不进 GitHub Release**。

获取方式：
1. 打开该次提交对应的 `android-debug` workflow run 页面；
2. 拉到底部 Artifacts 区，下载 `drawpaper-android-debug` 压缩包，解压得到 `app-debug.apk`；
3. 侧载（sideload）到 Android 平板测试。

> RC 阶段不提供签名 release APK；未来若上架应用商店，需要单独的签名流程与 keystore，不在本手册范围。

### 4.3 Web PWA

浏览器直接打开部署地址即可「添加到主屏幕」离线使用，无需 Release 产物。

## 5. 以后发版要改的版本号文件清单

发版时把下列文件里的版本号统一改成新版本（例如 `0.1.0` 或 `0.2.0`）：

| 文件 | 字段 | 说明 |
|---|---|---|
| `package.json`（根） | `version` | monorepo 根元数据 |
| `packages/web/package.json` | `version` | PWA 包元数据 |
| `apps/desktop-tauri/src-tauri/tauri.conf.json` | `version` | **决定 NSIS 产物文件名与应用内版本** |
| `apps/desktop-tauri/src-tauri/Cargo.toml` | `[package] version` | Rust crate 版本 |
| `apps/desktop-tauri/src-tauri/Cargo.lock` | `[[package]]` 中 `name = "drawpaper"` 的 `version` | 与 Cargo.toml 保持一致 |
| `apps/mobile-capacitor/package.json` | `version` | Capacitor 外壳 JS 元数据 |
| Android `versionName` | `apps/mobile-capacitor/android/app/build.gradle` 的 `versionName` | **仅当 android 工程已在本地生成**时同步；`versionCode` 保持整数递增、不要回退。本仓库 android 工程由 CI 临时生成、不入库，故发版时通常无需手改。 |

不改动（刻意保持现状）：
- `packages/core/package.json` 的 `version`：内部私有逻辑库，不影响任何交付物，维持 `0.0.0`。
- `apps/desktop-tauri/package.json` 的 `version`：Tauri CLI 的 JS 包装元数据，不参与 NSIS 命名（以 `tauri.conf.json` 为准）。
- PWA manifest（`packages/web/vite.config.ts` 的 `VitePWA.manifest`）：当前不含独立 `version` 字段，`name` / `short_name` 保持不变；PWA 缓存由 Workbox 构建哈希自动失效。

改完后本地跑一遍 `pnpm -r build` 确认 PWA 仍能构建，再走 §2 打 tag。

## 6. 自动更新为何默认关闭

本期**未启用 Tauri 自动更新**，原因：

1. 仓库没有 `TAURI_SIGNING_PRIVATE_KEY`（签名私钥）；
2. 没有静态托管 `latest.json` 的更新服务器。

`tauri-plugin-updater` 在没有有效公钥时会让 `tauri build` 直接失败，因此 `Cargo.toml` 里故意不引入该插件。本版用户升级方式为：手动下载新的 NSIS 安装包覆盖安装。

接入自动更新的完整 checklist（生成密钥对、公钥填入 `tauri.conf.json`、私钥存 GitHub Secrets、release 产出 `.sig`、前端 `Updater.check()` 指向 Releases 静态地址）见 **[`docs/p2-tauri-ci.md` §3](./p2-tauri-ci.md#3-自动更新updater--故意不启用)**。

## 7. 回滚方式

- **删 Release**：在 GitHub Releases 页面删掉误发的预发布 Release（不影响代码与 tag）。
- **移动 / 删除 tag**（必须重发时）：
  ```bash
  # 删远端 tag 后本地重建到正确 commit
  git push origin :refs/tags/v0.1.0-rc.4
  git tag -d v0.1.0-rc.4
  git checkout <correct-commit-sha>
  git tag -a v0.1.0-rc.4 -m "drawpaper 0.1.0-rc.4 (pre-release)"
  git push origin v0.1.0-rc.4
  ```
- **版本号回退**：若某个版本号打错了（例如把 `-rc.1` 打成 `-rc.2`），按 §5 改回版本文件并合并到 develop，再用修正后的 tag 重发；已发错 tag 的 Release 按上面删除。
- 代码本身不回滚：develop 已合入的功能不因为某个 tag 发错而撤回，下一个 tag 带上修复即可。

## 8. 发布前文档核对清单

- [ ] 发布前确认 `docs/sync.md` 的截图 / 操作步骤与最终 UI 文案一致（跨设备同步文档先行编写，同步设置项的按钮名 / 弹窗标题可能在开发阶段微调，见该文 §2.5 注）。

## 9. 代码签名（Code Signing）—— 当前未启用

> 本节只描述现状与接入路径，**本期不实现、不提交任何证书或私钥**。

### 9.1 现状

本仓库的 NSIS 安装包（`drawpaper_*_*-setup.exe`）**当前未做 Authenticode 代码签名**。后果：

- 首次在 Windows 10/11 上双击安装时，SmartScreen 会弹出「Windows 已保护你的电脑」蓝色提示（因为该发布者没有信誉），用户需要点「更多信息 → 仍要运行」才能继续。
- 杀毒软件对未签名、从 GitHub Release 下载的未知 exe 可能产生额外启发式告警。
- 这是 RC 阶段的已知现状，不是 CI 失败。

### 9.2 接入代码签名需要什么

1. **一张代码签名证书（PFX）**
   - 从受信任 CA（DigiCert / Sectigo / SSL.com 等）购买；EV 证书可立即获得 SmartScreen 信誉，OV 证书需要积累下载量后才会被 SmartScreen 信任。
   - 证书以 `.pfx`（PKCS#12）文件形式拿到，含私钥与证书链。
2. **GitHub Secrets（在仓库 Settings → Secrets and variables → Actions 配置，不要入库）**
   - `CERTIFICATE_BASE64`：`.pfx` 文件 base64 编码后的字符串（`base64 -w0 cert.pfx`）。
   - `CERTIFICATE_PASSWORD`：导出 PFX 时设置的口令。
3. **CI 集成（在 `release-windows.yml` 的 build job 里，`tauri build` 之前/之后做）**
   - 用官方 `tauri-apps/tauri-action`（它原生支持读 `TAURI_SIGNING_IDENTITY` 等环境变量并在打包后调用 signtool）；或在 NSIS 产物出来后用 Windows SDK 自带的 `signtool sign /f cert.pfx /p $env:CERTIFICATE_PASSWORD /fd sha256 /tr <timestamp-url> /td sha256 <installer.exe>`。
   - 注意：Tauri 的 `TAURI_SIGNING_PRIVATE_KEY*` 这一组 secret 是给 **updater 签名**（见 §10）用的，和 Authenticode 代码签名（`CERTIFICATE_BASE64` / `CERTIFICATE_PASSWORD`）是**两套不同的密钥**，不要混用。
4. **签名后**：安装包在 Release 页面附 `SHA256SUMS.txt`（见 §4.1，由 publish job 生成），用户校验完整性；SmartScreen 提示会随证书信誉积累而消失。

> 在拿到证书之前，不要在 CI 里留任何占位 secret 引用；未签名就保持现状并在 Release 正文说明「未签名，首次运行需点仍要运行」。

## 10. 自动更新启用清单（Tauri Updater）—— 未来接入用

> §6 解释了为什么本期故意不启用。本节是**完整的接入 checklist**，纯文档，执行时再按此操作。

1. **生成 updater 签名密钥对（一次性）**
   ```bash
   pnpm tauri signer generate -w ~/.tauri/drawpaper.key
   ```
   产物：`drawpaper.key`（私钥）+ 终端打印的公钥字符串。**私钥离线保存好，丢失则所有已发版用户永远收不到更新。**
2. **公钥填入 `tauri.conf.json`**：在 `plugins.updater.pubkey` 填第 1 步打印的公钥字符串；同时在 `plugins.updater.endpoints` 填更新检查地址（指向 GitHub Releases 上的 `latest.json` 静态 URL，例如 `https://github.com/<org>/drawpaper--freedom/releases/latest/download/latest.json`）。
3. **引入 updater 插件**：`apps/desktop-tauri/src-tauri/Cargo.toml` 加入 `tauri-plugin-updater`，并在 `lib.rs` 注册插件（当前刻意未加，见 §6）。
4. **私钥存 GitHub Secrets**：
   - `TAURI_SIGNING_PRIVATE_KEY`：`drawpaper.key` 文件内容（多行，原样）。
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成时设置的口令（无口令则留空）。
5. **CI 产出入 `.sig`**：用 `tauri-apps/tauri-action`（而非直接调 `tauri` CLI）打包，它会自动用上述 secret 给每个 NSIS 产物生成同名 `.sig` 文件；publish job 把 `.sig` 一并上传到 Release。
6. **产出 `latest.json`**：publish job 在创建 Release 后，按 Tauri updater 格式生成 `latest.json`（含 `version`、`notes`、`pub_date`、`platforms.windows-x86_64.url` / `platforms.windows-aarch64.url` 与对应签名），作为 Release asset 上传；它是用户端 `Updater.check()` 拉取的清单。
7. **前端调用**：在设置页加「检查更新」按钮，调用 `tauri-plugin-updater` 的 `check()` → 发现新版本 → `downloadAndInstall()` → 重启。
8. **验证**：先发一个 RC tag，确认 Release 上有两个 `.exe` + 两个 `.sig` + `latest.json` + `SHA256SUMS.txt`，旧版应用能在 20s 内检测到新版本。

> 再次强调：`TAURI_SIGNING_PRIVATE_KEY*`（updater 签名）与 §9 的 `CERTIFICATE_BASE64`（Authenticode 代码签名）是两套密钥，前者用于「更新包是否被篡改」，后者用于「安装包是否被 Windows 信任」。
