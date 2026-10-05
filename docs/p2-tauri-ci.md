# P2 Tauri 收尾 + CI/CD（Web CI 与 Windows 出包）

> 本波（Wave 6b-#5）交付：Tauri 桌面壳补全（通知/自动备份/文件关联核对）、
> GitHub Actions 真实 CI（`web-ci`）、Windows NSIS 安装包出包工作流
> （`release-windows`，x64+ARM64）、Android debug APK 工作流。
> 这是本仓库第一个**真实在 GitHub Actions 上跑绿**的 CI/CD 波次。

## 1. 工作流矩阵

| 工作流 | 文件 | 触发 | runner | 产物 |
|---|---|---|---|---|
| web-ci | `.github/workflows/web-ci.yml` | push develop/feat/**/fix/** + PR | ubuntu-latest | （测试报告 artifact，7 天） |
| release-windows | `.github/workflows/release-windows.yml` | push tag `v*` | windows-latest ×2（x64/arm64） | GitHub Release 上的 NSIS `.exe` |
| android-debug | `.github/workflows/android-debug.yml` | push develop/feat/**/fix/** + PR | ubuntu-latest | `app-debug.apk` artifact（14 天） |

### 1.1 web-ci 步骤

1. checkout → pnpm 11.7.0（`run_install: false`）→ setup-node@v4 node 22 + pnpm cache
2. `pnpm install --frozen-lockfile`
3. `pnpm -r build`（core ESM → web PWA）
4. `pnpm typecheck` → `pnpm lint`
5. `pnpm -r test`（core 140 + web 178 单测）
6. `node packages/web/scripts/verify-precache.mjs`（PWA 预缓存完整性守门）
7. `packages/web` 下 `pnpm exec playwright install --with-deps chromium`
8. `npx playwright test`（32 e2e，dev server 自起在 4173）
9. 上传 `playwright-report/` + `test-results/` artifact

**CI 兼容修复**：`packages/web/playwright.config.ts` 原本无条件把
`PLAYWRIGHT_BROWSERS_PATH` 覆盖为沙箱路径 `/home/user/ms-playwright`。CI runner
上该路径不存在会直接失败。改为 `fs.existsSync(LOCAL_BROWSERS_PATH)` 才覆盖——
本机行为不变，CI 走默认 `~/.cache/ms-playwright`。

### 1.2 release-windows 步骤

```
tag v* push
  ├─ build (matrix x64)   → tauri build --bundles nsis           → upload artifact nsis-x64
  ├─ build (matrix arm64) → rustup target add aarch64-msvc       → upload artifact nsis-arm64
  │                         tauri build --bundles nsis --target aarch64-pc-windows-msvc
  └─ publish (needs: build) → 下载两个 artifact → gh release create
                              tag v0.1.0-rc.1 → prerelease: true（tag 含 '-' 即预发布）
```

**为什么 build 与 publish 分两个 job**：两个 matrix job 并行跑，若都直接调
`tauri-action` 创建 GitHub Release，会竞争创建同一个 tag 的 release（409/覆盖）。
让 build job 只出包、不发布（不传 `tagName`），由单线程的 `publish` job 统一收集
并 `softprops/action-gh-release@v2` 创建 release，最稳。

### 1.3 android-debug 步骤

JDK 17 + android-actions/setup-android@v3 → 接受 licenses → `apps/mobile-capacitor`
下 `pnpm install --ignore-workspace` → `npx cap add android`（CI 临时生成 android 工程，
不入库）→ `npx cap sync android` → `./gradlew assembleDebug` → 上传
`app-debug.apk`。无签名、不上架。

## 2. Tauri 补全清单（本波）

| 项 | 状态 | 位置 |
|---|---|---|
| 原生菜单（文件/编辑/导出/视图/帮助） | ✅ 已有（P2 波） | `src-tauri/src/lib.rs::build_menu` |
| open/save/print commands | ✅ 已有 | `open_kbnote` / `save_kbnote` / `print` |
| 最近文件列表（JSON 持久化） | ✅ 已有 + 核对 | `list_recents` / `clear_recents`，存 app_config_dir |
| `.kbnote` 文件关联 | ✅ 核对 | `tauri.conf.json → bundle.windows.fileAssociations` |
| 单实例 + 双击打开转发 | ✅ 核对 | `tauri-plugin-single-instance` + `maybe_seed_startup_file` |
| **原生通知**（保存成功/失败/迁移提示） | ✅ 新增 | `tauri-plugin-notification` + `notify(title, body)` 命令 |
| **真实文件夹自动备份** | ✅ 新增 | `backup_doc(title, text)` 写 `app_data_dir/backups/{标题}_备份_{ts}.kbnote`，保留最近 20 份 |
| tauri-host 接线 notify/backupDoc | ✅ 新增 | `packages/web/src/host/tauri-host.ts` |
| 自动更新（updater） | ⏸️ **故意不启用** | 见下文 §3 |

### 2.1 原生通知

`tauri-plugin-notification` 在 Windows 上发到 Action Center。web 侧浏览器端走
既有 in-app toast；桌面端由集成期在保存成功/失败/迁移提示处判断
`host instanceof TauriHostAdapter` 后调用 `host.notify(title, body)`。失败静默
（用户关了通知权限也不报错）。

### 2.2 自动备份

`backup_doc` 把当前文档写一份时间戳快照到 `app_data_dir/backups/`，文件名
`{标题}_备份_{毫秒时间戳}.kbnote`，每次写完按 mtime 裁剪到最近 20 份。这是
Dexie 之外的磁盘兜底——即使浏览器存储被清，用户也能在备份目录双击 `.kbnote`
恢复。防抖 500ms 由调用方控制（与 OPFS autosave 同一节奏）。

## 3. 自动更新（Updater）—— 故意不启用

本仓库当前**没有** `TAURI_SIGNING_PRIVATE_KEY`，也没有静态托管 `latest.json`
的更新服务器。`tauri-plugin-updater` 在没有公钥的情况下会让 `tauri build`
直接失败。所以本波**不引入** updater 插件，Cargo.toml 里留了注释说明。

**后续接入 checklist**：

1. `pnpm tauri signer generate -w ~/.tauri/drawpaper.key` 生成签名密钥对；
2. 把公钥填进 `tauri.conf.json > plugins.updater > pubkey`，私钥存 GitHub
   Secrets（`TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）；
3. 在 release-windows.yml 的 tauri-action 步骤注入私钥环境变量；
4. release job 额外产出 `.sig` 文件并由 `softparams/action-gh-release` 上传；
5. 前端 `Updater.check()` 指向 GitHub Releases 静态地址（或自建 `latest.json`）。

在那之前，用户升级靠手动下载新的 NSIS 安装包覆盖安装。

## 4. tag / 发布流程

```bash
# 1. 分支推绿 web-ci 后，切到要发布的 commit
git checkout feat/p2-tauri-ci

# 2. 打预发布 tag（轻量 tag 即可，tag 会包含 workflow 文件）
git tag v0.1.0-rc.1
git push origin v0.1.0-rc.1

# 3. 轮询（公开仓库，未认证）：
#    https://api.github.com/repos/guzifeng123/drawpaper--freedom/actions/runs?event=push
#    看 release-windows 的两个 build job + publish job。

# 4. 失败修复后重打 tag：
git push origin :refs/tags/v0.1.0-rc.1
git tag -f v0.1.0-rc.1 <new-commit-sha>
git push origin v0.1.0-rc.1
```

`publish` job 按 tag 是否含 `-` 自动判断 prerelease（`v0.1.0-rc.1` → prerelease，
`v1.0.0` → stable）。

## 5. CI 运行 URL 与结论

工作流已推送至 `feat/p2-tauri-ci`（commits d802c1e → 24aacc0）。

**已确认的云端 run**（未认证 API 轮询所得）：

| run | workflow | commit | 结论 | URL |
|---|---|---|---|---|
| 37276063882 | web-ci | d802c1e | ❌ failure（Install dependencies） | https://github.com/guzifeng123/drawpaper--freedom/actions/runs/37276063882 |
| 37276063898 | android-debug | d802c1e | ❌ failure（Install dependencies） | https://github.com/guzifeng123/drawpaper--freedom/actions/runs/37276063898 |

**排查与修复迭代**：

1. 首跑（d802c1e）：`pnpm install --frozen-lockfile` 在 runner 失败。根因判断为
   `.npmrc` 把 registry 钉到 `registry.npmmirror.com`（国内镜像，US runner 连通性差）。
2. 0bd278f：加 job 级 `npm_config_registry=npmjs.org` env —— 仍失败（同一步）。
3. ea81698：加诊断步骤（`pnpm -v`/`node -v`/`pnpm config get registry`）+ append-only reporter。
4. 6933476：改 `--no-frozen-lockfile`。
5. 24aacc0：install 命令加 CLI 级 `--registry=https://registry.npmjs.org/`（CLI flag
   优先级高于 .npmrc，比 env 更确定）。

**当前状态（诚实标注）**：24aacc0 已推送，其 run 的结论因本机出口共享 IP 被 GitHub
未认证 API 限流（60 req/h 耗尽）无法在本波次内轮询确认。本地门禁全绿
（build/typecheck/lint 0 error；单测 core 140 + web 178；precache 校验通过）。
后续在未限流窗口或配 GITHUB_TOKEN 后应轮询
`https://github.com/guzifeng123/drawpaper--freedom/actions` 确认 web-ci 转绿，
再打 `v0.1.0-rc.1` tag 触发 release-windows。

**release-windows / v0.1.0-rc.1 tag**：本波次**未打 tag**——因为 web-ci 尚未云端转绿，
打 tag 会直接触发 Windows 出包并大概率失败。YAML 经人工核验（action 版本、matrix、
tauri-action 用法、publish job 收敛 release 创建），但**未经云端实跑**。这是本波次
的客观遗留：本机出口限流导致无法在窗口内完成"推 tag→轮询→修→重打"循环。

## 6. Android / iOS 状态

- **Android debug APK**：`android-debug.yml` 在每次 push 出一个 unsigned debug
  包，可侧载到平板测试。未签名、未上架。
- **iOS**：**本期不做**。需要 Apple Developer 账号（$99/年）+ 签名证书 +
  Xcode 构建机（macOS runner）。`apps/mobile-capacitor/capacitor.config.ts` 已保留
  iOS 配置骨架，未来开通账号后 `npx cap add ios` 即可。

## 7. 明确不做项及原因

| 项 | 原因 |
|---|---|
| iOS 上架 | 需 Apple Developer 账号 + 签名证书 + macOS runner，本期无此条件 |
| Yjs/CRDT 实时协作 | 规划 §4.13 明确不做；core `CollabAdapter` 空接口已预留，不装 yjs |
| 手绘墨迹块 | 需手写笔压感/倾斜硬件预研，P2 后期才评估 |
| 自动更新 | 无签名私钥与更新服务器，见 §3 |
| 通知/全局快捷键/自动更新的用户设置 UI | 留给 P2 收尾后用户反馈驱动 |

## 8. 云端攻关全过程（feat/p2-tauri-ci，最终全绿）

安装关之后的失败点均通过"workflow 内 `::error::`/`::warning::` 注解（每级每步
10 条上限）+ run 页 `annotations_partial` 匿名片段端点"侧信道取日志定位（REST
日志 zip 对匿名用户 403、共享出口 IP 未认证 REST 60/h 秒光）。

| commit | 失败点 | 修复 |
|---|---|---|
| 0356eef | pnpm11 全新安装 ERR_PNPM_IGNORED_BUILDS 退出 1；YAML 步骤名冒号 | `pnpm-workspace.yaml` 加 `allowBuilds: {esbuild: true}` + 保留 `onlyBuiltDependencies: [esbuild]`；步骤名加引号；release matrix 改直接调 CLI 构建避免抢建 release；本地 `tauri icon` 生成全套图标并提交 |
| cd93b6e | — | release-windows 加分支 push + workflow_dispatch 触发（publish 仅 tag）；web-ci 转绿 |
| 6c03db6 | setup-android@v3 被强制 Node24 运行崩溃 | 手工下载固定 cmdline-tools(11076708) + licenses + platform-34；android 转绿产出 APK |
| 050bd61 | tauri.conf schema：fileAssociations 位置/字段、linux.appDependencies 非法、CSP 字体源 | fileAssociations 移到 bundle 顶层（ext/name/description/role=Editor）；删非法字段；CSP 去 Google 字体 |
| 1dd6589 | frontendDist 路径解析 | 相对 src-tauri 改为 `../../../packages/web/dist`；beforeBuildCommand 用 `pnpm --dir ../../packages/web build` |
| 2b12467 | 缺 icon.ico（apps 的 .gitignore 排除了图标） | 删忽略规则、提交全套图标 |
| 6eb679c | Rust 19 错：MenuItem::with_id/separator 返回 Result 未 unwrap、FilePath 需 `.into_path()`、缺 tokio sync、single-instance 顺序 | 全部 unwrap/转换；Cargo.toml 加 tokio(sync)；single-instance 移到首个插件 |
| 2f63c93 | Rust 4 错：不存在 AboutMenuItem、separator Result、MenuEvent 无 as_ref | 改 `PredefinedMenuItem::about(...)`（AboutMetadata 为 owned String/Vec）；separator unwrap；`event.id.0.as_str()`（muda 0.20 MenuId(pub String)） |
| 59eba69 | Rust 1 错 E0107：build_menu 返回 `Menu` 缺泛型 | 返回 `Menu<tauri::Wry>`，编译通过进入 NSIS 打包 |

**最终云端结论（tip 59eba69，Run 9/8/8）**：web-ci / release-windows /
android-debug 三条全绿；release-windows 两个 matrix 作业（x86_64 与
aarch64-pc-windows-msvc）均真实产出 NSIS artifact。

## 9. 合并 develop 后的云端复核（tip ba98029）

合并 `--no-ff`（merge 826594c）后，release-windows 构建矩阵的分支触发加上
`develop`（publish 仍仅 tag），develop tip ba98029 三条工作流全部真实跑绿：

| workflow | run | 结论 | 产物 |
|---|---|---|---|
| web-ci | https://github.com/guzifeng123/drawpaper--freedom/actions/runs/37324154744 | success | install/build/typecheck/lint/单测/Playwright e2e/precache 全过 |
| release-windows | https://github.com/guzifeng123/drawpaper--freedom/actions/runs/37324154679 | success（build x64+arm64；publish 按设计 skipped，非 tag） | `nsis-x64` 3.02 MB（内含 drawpaper_0.2.0_x64-setup.exe）、`nsis-arm64` 2.88 MB（内含 drawpaper_0.2.0_arm64-setup.exe） |
| android-debug | https://github.com/guzifeng123/drawpaper--freedom/actions/runs/37324154843 | success | `drawpaper-android-debug` 4.9 MB（unsigned app-debug.apk） |

本地合并后门禁（develop tip）：`pnpm -r build` 通过（主 chunk 487KB、precache
81 条）、typecheck 0 error、eslint 0 error、单测 core 165 + web 199、Playwright
e2e 43 全过、verify-precache 通过。

**发布动作仍未执行**：未打任何 `v*` tag；正式 release（publish job 创建
GitHub Release 并挂两架构 setup.exe）由维护者审查后打 `v0.1.0-rc.1`/正式 tag
触发，步骤见 §4。
