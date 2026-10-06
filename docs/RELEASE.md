# 发布操作手册（RELEASE）

> 本手册面向维护者：在 develop 合并、CI 全绿之后，如何打 tag 触发发布、产物落在哪、以后发版要改哪些文件、以及出问题如何回滚。
> 当前版本：**0.1.0-rc.3**（预发布 / Release Candidate）。

## 1. 何时打 tag

- 前置：要发布的 commit 已合入 `develop`，且该 commit 在 GitHub 上的 `web-ci` / `release-windows`(build) / `android-debug` 三条 workflow 均为绿色。
- `chore/*`、`feat/*`、`fix/*` 分支本身不触发云端 workflow；只有合到 `develop` 并在 develop tip 跑绿后，才以 develop tip 的 commit 为基线打 tag。
- 本次（RC）约定 tag 为 `v0.1.0-rc.3`。正式版将为 `v0.1.0` / `v1.0.0` 等（不含 `-`）。

## 2. 打 tag 与推送

```bash
# 1) 切到要发布的 commit（通常是 develop tip）
git checkout develop
git pull --ff-only
git log --oneline -1          # 确认这是已跑绿的那个 commit

# 2) 打带注释的 tag（annotated tag）
git tag -a v0.1.0-rc.3 -m "drawpaper 0.1.0-rc.3 (pre-release)"

# 3) 只推这一个 tag（不要用 git push --tags，避免误推其他临时 tag）
git push origin v0.1.0-rc.3
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

版本号取自 `tauri.conf.json`（本版 `0.1.0-rc.3`），Tauri NSIS 产物命名规则为 `{productName}_{version}_{arch}-setup.exe`，因此本版：

- `drawpaper_0.1.0-rc.3_x64-setup.exe` — 64 位 Intel/AMD（Win10/11）
- `drawpaper_0.1.0-rc.3_arm64-setup.exe` — ARM64（Copilot+ PC、Surface Pro X 等）

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
  git push origin :refs/tags/v0.1.0-rc.3
  git tag -d v0.1.0-rc.3
  git checkout <correct-commit-sha>
  git tag -a v0.1.0-rc.3 -m "drawpaper 0.1.0-rc.3 (pre-release)"
  git push origin v0.1.0-rc.3
  ```
- **版本号回退**：若某个版本号打错了（例如把 `-rc.1` 打成 `-rc.2`），按 §5 改回版本文件并合并到 develop，再用修正后的 tag 重发；已发错 tag 的 Release 按上面删除。
- 代码本身不回滚：develop 已合入的功能不因为某个 tag 发错而撤回，下一个 tag 带上修复即可。

## 8. 发布前文档核对清单

- [ ] 发布前确认 `docs/sync.md` 的截图 / 操作步骤与最终 UI 文案一致（跨设备同步文档先行编写，同步设置项的按钮名 / 弹窗标题可能在开发阶段微调，见该文 §2.5 注）。
