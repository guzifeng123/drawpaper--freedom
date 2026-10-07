# Wave17 · M2 — `apps/desktop-tauri/README.md` 对齐审计（基线 `3451c37`）

> 分支：`chore/desktop-readme-audit`（纯文档）。目标：把 `apps/desktop-tauri/README.md`
> 从「脚手架分期（P2）」旧描述，逐条对齐到 `3451c37`（rc.8，已含 NSIS+MSI 双安装包矩阵、
> 手动 updater 与签名链路、诊断导出、便携模式、withGlobalTauri 修复、资产 hash GC 等）的真实现状。
>
> 方法：README 每一条命令 / 路径 / 声明都 grep 源码或 workflow 核实。下表「证据」列给出
> `文件:行号`（以 `3451c37` 为准）。本分支**不改任何代码 / yaml / json / toml / ps1**，
> 只产出修订后的 README、本审计记录、CHANGELOG 一条文档条目，以及用户指南最小交叉引用。

---

## 一、环境与开发（Node / pnpm / workspace / Tauri CLI / dev / build / 双架构）

| # | 原描述（旧 README） | 实际情况（证据） | 修订 |
|---|---|---|---|
| 1 | Node「≥ 20，与根仓库一致」；pnpm「11.x，根 packageManager 锁定」 | 根 `package.json:7` `packageManager: pnpm@11.7.0`；`engines.node: >=20`（`package.json:9`）；三条 workflow 都用 `actions/setup-node@v4` 装 **Node 22**（如 `.github/workflows/release-windows.yml:62-67`、`web-ci.yml:39-44`） | 改为「Node ≥20（CI 锁定 22）」「pnpm 11.7.0（packageManager 字段）」 |
| 2 | 「本目录装 Tauri CLI（独立装，不污染根 workspace）`pnpm install --ignore-workspace`」 | 属实，但旧 README 没讲清**为什么**。`pnpm-workspace.yaml:1-2` 只 glob `packages/*`；CI `release-windows.yml:72-74`「Install Tauri CLI (desktop shell, outside the pnpm workspace)」正是 `cd apps/desktop-tauri && pnpm install --ignore-workspace` | 新增「包管理模型」小节，明确 apps 在 workspace 外、根 `pnpm -r` 不触达本目录，并引用 CI 步骤为证 |
| 3 | `beforeDevCommand: pnpm --filter @drawpaper/web dev`；`beforeBuildCommand: pnpm --filter @drawpaper/web build` | 实际 `tauri.conf.json:7` = `pnpm --dir ../../packages/web dev`；`:9` = `pnpm --dir ../../packages/web build`（**已不是** `--filter` 写法） | 改为 conf 里的真实命令 |
| 4 | `frontendDist: ../../packages/web/dist` | 实际 `tauri.conf.json:10` = `../../../packages/web/dist`（相对 `src-tauri/` 三级回仓库根） | 改为真实相对路径 |
| 5 | 「启动桌面壳 `pnpm tauri dev`」「出包 `pnpm tauri build` / `--bundles msi` / `--bundles nsis`」 | `apps/desktop-tauri/package.json:8-11` 已封 script：`dev=tauri dev`、`build=tauri build`、`build:msi=tauri build --bundles msi`、`build:nsis=tauri build --bundles nsis` | 改用 npm script（`pnpm dev` / `pnpm build` / `pnpm build:nsis` / `pnpm build:msi`）；并注明 CI 直接调 `./node_modules/.bin/tauri build --ci` |
| 6 | 「先在根目录构建前端 `pnpm -r --filter "./packages/*" build`」 | 根 `package.json:13` `build = pnpm -r --filter "./packages/*" build`；CI `release-windows.yml:80` 用 `pnpm -r build` | 写「仓库根 `pnpm -r build`（等价于 conf 的 beforeBuildCommand）」 |
| 7 | 「ARM64 需 `rustup target add aarch64-pc-windows-msvc` 后交叉编译」（只一句） | CI 矩阵 `release-windows.yml:44-51`：x64 `extra_args: --bundles nsis,msi`；arm64 `--bundles nsis,msi --target aarch64-pc-windows-msvc`；`:76-77` `rustup target add ${{ matrix.rust_target }}` | 补全双架构命令：`tauri build --ci --bundles nsis,msi --target aarch64-pc-windows-msvc`；强调 `--bundles` 逗号无空格 |
| 8 | 目录树里 `src/` 只列 `main.rs` / `lib.rs`；icons 写「占位 icon.svg，正式图标用 pnpm tauri icon 生成」 | `src-tauri/src/` 现有 `main.rs / lib.rs / portable.rs / diagnostics.rs`；`icons/` 已提交完整集（icon.ico、Square*.png、installer-header.bmp、installer-sidebar.bmp），`apps/desktop-tauri/.gitignore` 注释「Tauri icon set IS committed」 | 目录树补 `portable.rs` / `diagnostics.rs` / `ci/smoke-portable.ps1`；icons 描述改为「已提交的完整图标集 + 品牌位图」 |
| 9 | 目录树列 `.gitignore` | 核实 `apps/desktop-tauri/.gitignore` **确实存在**（271B） | 保留（核对无误，见第三节） |

## 二、CI 定位（release-windows / web-ci / android-debug / 本地冒烟）

| # | 原描述 | 实际情况（证据） | 修订 |
|---|---|---|---|
| 10 | 旧 README **完全没有 CI 章节** | 三条 workflow：`release-windows.yml`（push tag `v*` + 分支白名单 + `workflow_dispatch`，`:15-32`；build 矩阵 x64/arm64 `:42-51`；`publish` job 仅 tag push `:1489-1494`）；`web-ci.yml`（push `develop`/`feat/**`/`fix/**` + PR，`:3-11`）；`android-debug.yml`（仅 `workflow_dispatch` + tag `v*`，`:9-13`） | 新增「CI 定位」表格，逐条写清触发与产物 |
| 11 | — | `web-ci` push 白名单**不含 `chore/**`**；`release-windows` 分支白名单也不含本类文档 chore 分支。push 后无 CI run 是预期 | 明确写「纯文档 chore 分支不触发 CI 是预期，不要改白名单；验证方式 = 逐条 grep 源码」 |
| 12 | — | 冒烟：NSIS `/S /CURRENTUSER`（`release-windows.yml:316-317`）；MSI `msiexec /i ... /qn /norestart`（`:1208-1210`）与 `/x /qn` 卸载（`:1441-1443`）；便携模式独立脚本 `apps/desktop-tauri/ci/smoke-portable.ps1`（grep 确认**未被** workflow 引用） | 新增「本地手动冒烟」说明，含便携脚本 `-ExePath` 用法 |

## 三、安装包矩阵（NSIS + MSI + 命名 + SHA256SUMS）

| # | 原描述 | 实际情况（证据） | 修订 |
|---|---|---|---|
| 13 | 「出包（MSI / NSIS）…当前 bundle.targets 仅声明 `["msi", "nsis"]`」 | `tauri.conf.json:34-37` 实际 `targets: ["nsis", "msi"]`（顺序 nsis 在前） | 改为 `["nsis","msi"]` |
| 14 | 旧 README 只说「同时打 msi + nsis」，无矩阵、无命名、无静默参数 | Release 正文（`release-windows.yml:1624-1633`）命名：NSIS `drawpaper_*_x64-setup.exe` / `drawpaper_*_arm64-setup.exe`；MSI `drawpaper_*_x64_en-US.msi` / `drawpaper_*_arm64_en-US.msi`；`SHA256SUMS.txt` 覆盖四个 | 新增「安装包矩阵」表格，列四个产物名 + 适用对象 |
| 15 | — | NSIS `installMode:"both"`（`tauri.conf.json:51`）；`displayLanguageSelector:true` + `languages:[SimpChinese,English]`（`:52-56`）；`headerImage/sidebarImage` 品牌位图（`:57-58`）；CI 静默安装 `/S /CURRENTUSER`（`:316-317`） | NSIS 小节补 both 模式 / 双语选择器 / 品牌位图 / `/CURRENTUSER` 静默 |
| 16 | — | MSI 固定 perMachine 落 Program Files（`msi-bundle.md` §3.1；CI `:1227-1234`）；en-US culture（产物名 `_en-US`，`windows-user-guide.md:14,16`）；企业 `msiexec /i ... /qn` 与 `/x ... /qn`（CI `:1208`、`:1441`） | MSI 小节补按机器安装 / 英文界面 / `msiexec /i /qn` 部署与 `/x /qn` 卸载 |
| 17 | — | `wix.version:"0.1.0.8"`（`tauri.conf.json:60-62`）。原因：MSI ProductVersion 必须纯数字 `major.minor.patch.build`，不接受 semver `rc.`；不改 app 对外版本，用 MSI-only 覆盖（`msi-bundle.md` §3.0，`:34-54`） | 补「数字版本覆盖原因」并引用 `docs/wave15/msi-bundle.md §3.0` |
| 18 | — | `SHA256SUMS.txt`：publish job 对四个包各算一行 `<sha256>  <basename>`，要求 ≥4 行（`release-windows.yml:1533-1552`） | 写用法 `sha256sum -c SHA256SUMS.txt` |

## 四、WebView2

| # | 原描述 | 实际情况（证据） | 修订 |
|---|---|---|---|
| 19 | 「WebView2 Runtime：自带于 Win11；Win10 需手动装 Evergreen 运行时；Tauri 2 不打包 WebView2，走系统自带」 | 现状 `downloadBootstrapper`（不内嵌），由 NSIS 在安装时引导联网；结论见 `docs/wave15/webview2-offline.md` §4「保留默认 downloadBootstrapper，不启用离线内嵌」 | 写清 Evergreen 现状（装时联网引导，不内嵌） |
| 20 | — | 首装 SmartScreen 蓝色提示：安装包未做 Authenticode 签名（`RELEASE.md` §9.1 `:124-130`；`windows-user-guide.md` §1.1） | 补 SmartScreen「更多信息→仍要运行」说明，并指向 §9 |
| 21 | — | 离线环境手动装 Runtime：完整 Evergreen Standalone ≈ **202MB**（x86 实测，`webview2-offline.md` §3/§4），超 180MB 预算故不内嵌；官方入口 `https://developer.microsoft.com/microsoft-edge/webview2/`（选 Standalone Installer） | 写离线手动装说明 + 官方入口，**引用** `docs/wave15/webview2-offline.md` 的 202MB 结论而不内嵌数据表 |

## 五、应用能力清单（菜单 / 命令 vs 代码）

| # | 原描述 | 实际情况（证据 `lib.rs::build_menu`） | 修订 |
|---|---|---|---|
| 22 | 文件菜单只列「新建/打开/保存/另存为/打开最近/清空最近」 | 实际 `:680-699`：新建画布 / 打开…Ctrl+O / 保存 Ctrl+S / 另存为…Ctrl+Shift+S / 分隔 / 动态「打开最近」子菜单（`:772-803`）+「清空最近」 | 按实际文案 + accelerator 重写 |
| 23 | 编辑菜单只列「撤销/重做」 | 实际 `:701-710`：撤销 Ctrl+Z / 重做 Ctrl+Shift+Z / 分隔 / 剪切/复制/粘贴/全选（原生剪贴板角色） | 补全 |
| 24 | 导出只列「打印（另存为 PDF）/ 直接下载 PDF」 | 实际 `:712-717`：打印/另存为 PDF Ctrl+P / 直接下载 PDF / 导出 PNG / 导出 SVG / 导出 Markdown | 补 PNG/SVG/MD |
| 25 | 视图只列「适应屏幕/放大/缩小」 | 实际 `:719-726`：适应屏幕 Ctrl+0 / 放大 Ctrl+= / 缩小 Ctrl+- / 分隔 / 深色模式 / 大纲面板 / 搜索…Ctrl+F | 补深色模式/大纲/搜索 |
| 26 | 无「同步」菜单 | 实际 `:730-731`：同步 → 同步设置…（emit `sync:settings`） | 新增同步子菜单 |
| 27 | 帮助只列「关于」 | 实际 `:733-757`：关于 drawpaper（原生 About）/ **检查更新…**（手动）/ **打开数据目录** / **导出诊断信息…** / 分隔 / 项目主页 | 帮助菜单补「检查更新（纯手动）/ 导出诊断信息 / 打开数据目录 / 项目主页」 |
| 28 | 「已知未实现：系统通知（tauri-plugin-notification）」 | **过时/错误**：`Cargo.toml:29` 已依赖 `tauri-plugin-notification`；`lib.rs:493-500` `notify` 命令实际 post 到 Windows 操作中心；capabilities 也含 `notification:*`（`default.json`） | 删除「系统通知未实现」，改为能力清单里的「原生通知」 |
| 29 | 「已知未实现：自动更新（tauri-plugin-updater）— 留给 P2 收尾」 | **过时**：`Cargo.toml:44` 已依赖 `tauri-plugin-updater`；`lib.rs:594-666` `run_manual_update_check` 已落地（纯手动、零后台） | 删除「自动更新未实现」，改为「更新器配置」章节 |
| 30 | 「已知未实现：全局快捷键（菜单快捷键目前仅在 WebView 里由 web 侧监听 Ctrl+S/P）」 | 现状：文件/编辑/视图菜单已绑原生 accelerator（`:682-726`）；但「全局快捷键」（应用外热键）确实未做——同波 J/K/L 在并行做，本分支不引用未合入功能 | 不把「全局快捷键未实现」写成确定结论；只描述 3451c37 已存在的原生 accelerator |
| 31 | 「HostAdapter 命令表」只列 6 条，并把 `choose_auto_save_dir/auto_save_doc` 标「P2 增强，未接线」 | `invoke_handler`（`lib.rs:1136-1152`）实际注册 15 条：open_kbnote/save_kbnote/save_export/print/list_recents/clear_recents/get_startup_file/choose_auto_save_dir/auto_save_doc/notify/backup_doc/set_window_title/bind_native_file/set_native_dirty/force_quit；`save_export` 支持 pdf/png/svg/md（`:293-346`） | 重写命令表，按实际 15 条分组；auto-save 表述为「骨架命令（已注册）」 |

## 六、数据目录（安装版 vs 便携版）

| # | 原描述 | 实际情况（证据） | 修订 |
|---|---|---|---|
| 32 | 旧 README 只在命令表提「最近文件 JSON 持久化在 app config dir」，无数据目录章节 | 安装版：recents/autosave/window-state 在 app_config_dir；backups 在 app_data_dir（`lib.rs:50-53,527-566`）；logs 在 app_log_dir（`lib.rs:1069-1070` 指向 `data_dir/logs/drawpaper.log`）；WebView2 EBWebView 在 app_local_data_dir | 新增「数据目录」表，列 Roaming/Local 下 com.drawpaper.app 的内容 |
| 33 | — | **双根发现**：CI 冒烟对 `%APPDATA%` 与 `%LOCALAPPDATA%` 下 `com.drawpaper.app` **双根搜索**（`release-windows.yml:754` 注释「tauri-plugin-log 的 app_log_dir 与 recents app_config_dir 可能解析到 Roaming 或 Local，按 Tauri 版本而定」） | 明确「不要写死单根」，与冒烟口径一致 |
| 34 | 旧 README 完全无便携模式 | `portable.rs:32-34`：marker `drawpaper.portable` 或已存在 `data/` 目录触发；`:96-145` 纯决策（Windows + 触发 + `data/` 可写三条件）；`:13-24` 注释列出重定向的全部路径（config/data/log/local_data/cache） | 新增「便携模式」小节：marker 规则、exe\data 内容、与安装版互不干扰、只读回退 |
| 35 | — | 便携版零注册：不写注册表 / 不注册 `.kbnote` / 无快捷方式（`windows-user-guide.md:106`）；文件关联与快捷方式只有安装器写（CI 冒烟探测 HKCU/HKLM + 桌面/开始菜单 lnk，`:402-497`） | 写明「零注册（文件关联/快捷方式仅安装器有）」 |

## 七、诊断导出

| # | 原描述 | 实际情况（证据） | 修订 |
|---|---|---|---|
| 36 | 旧 README 完全无诊断导出 | 菜单路径「帮助→导出诊断信息…」（`lib.rs:755`、回调 `:1042-1094`）；隐藏 CLI `--diag-export <zip`（`lib.rs:917-928`） | 新增「诊断导出」小节，含菜单 + CLI 两条入口 |
| 37 | — | zip 四项：`system.json` / `logs/drawpaper.log` / `files-manifest.json` / `README.txt`（`diagnostics.rs:9-12,145-148`）；日志尾 `LOG_TAIL_BYTES=256*1024`（`diagnostics.rs:29-30`）；manifest 每条目**仅 name/size/mtime**（`diagnostics.rs:59`，CI 断言 `:1102-1108`） | 列 zip 内容与 256KB 上限、清单三字段 |
| 38 | — | 隐私边界：不含 `.kbnote` 正文、不含 `assets/` 字节（`diagnostics.rs:391-393`；CI 金丝雀 `:1076-1085`）；清单仍按名字列文件（仅元数据，`:1109-1110`） | 写明隐私边界 |

## 八、更新器配置（发版维护者视角）

| # | 原描述 | 实际情况（证据） | 修订 |
|---|---|---|---|
| 39 | 旧 README「自动更新留给 P2」 | 手动检查：`help:check-update` 是全 crate 唯一 updater 网络点，零后台（`lib.rs:1025-1031`、注释 `:568-586`）；无更新/离线/错误一律 `open_releases_page`（`:590-592,612-621`） | 写「纯手动、零后台；无网回退打开 Releases 页」 |
| 40 | — | 密钥：`tauri signer generate`；公钥已入 `tauri.conf.json:81`（base64 注释解码 = minisign pubkey ID **F4E906AB9D83F130**）；endpoint `:82-84` 指向 `.../releases/latest/download/latest.json` | 写公钥 ID 与 endpoint |
| 41 | — | 私钥入 GitHub secret **`TAURI_SIGNING_KEY`**（Settings→Secrets→Actions）；无口令则**无需** `TAURI_SIGNING_KEY_PASSWORD`（`RELEASE.md:156`；CI `release-windows.yml:118-131`） | 写 secret 名与「无口令免 PASSWORD」 |
| 42 | — | tag 发布才产 `.sig`（build job，`:125-131`）与 `latest.json`（publish job，`:1554-1598`）；未配 secret 时 build 跳过签名不失败、publish 跳过 latest.json（`:1568-1570`） | 写「配 secret → tag 产 latest.json/.sig 应用内更新才生效；未配则降级不失败」 |
| 43 | — | updater 签名（`TAURI_SIGNING_KEY`）与 Authenticode 代码签名（`CERTIFICATE_BASE64`，§9）是**两套密钥**（`RELEASE.md:142,164`） | 写明勿混用，引用 §9/§10 |

## 九、交叉引用（README ↔ docs）

| # | 原描述 | 实际情况 | 修订 |
|---|---|---|---|
| 44 | 旧 README 末尾无任何 docs 链接 | 核对以下相对路径**全部存在**：`docs/windows-user-guide.md`、`docs/sync.md`、`docs/RELEASE.md`、`docs/wave15/{webview2-offline,updater,msi-bundle,diagnostics,desktop-gap-audit}.md`、`docs/wave16/portable-mode.md`、`docs/p2-tauri-ci.md`、`docs/p2-shells.md` | README 末尾新增「相关文档」清单，逐条带路径 |
| 45 | 用户指南已存在且内容准确（§0–§8） | 其内部链接 `wave16/portable-mode.md`（`:109`）、`sync.md`（`:157`）均存在；指南本身已覆盖安装/数据/便携/WebView2/更新/诊断 | 用户指南**只补**「相关文档→README / README→用户指南」的交叉引用链接，不新增功能描述（同波 J/K/L 在写冷启动竞态、文件夹自动保存、全局快捷键小节，本分支不替他们写、不引用未合入功能） |

---

## 附：核对过且确认**无误**（无需修改）的清单项

- `apps/desktop-tauri/.gitignore` 存在（旧目录树列它是对的）。
- `pnpm-workspace.yaml` 只含 `packages/*`（apps 在 workspace 外）——旧 README 「独立 package.json，不进根 pnpm workspace」属实。
- `beforeDevCommand/beforeBuildCommand/devUrl=5173` 这几个键名与 dev 端口属实（仅命令内容从 `--filter` 改为 `--dir`，见 #3）。
- `.kbnote` 双击关联 + `maybe_seed_startup_file` 读 `argv[1]` + 单实例转发二次双击——旧 README 描述属实（`lib.rs:900-910`、单实例 `Cargo.toml:26`）。
- 文件关联 `.kbnote`（`tauri.conf.json:68-77`）、`withGlobalTauri:true`（`:13`）、`dragDropEnabled:false`（`:25`）、CSP（`:29`）。
- 「菜单项点击后 Rust emit `app:menu{id}` 推前端」这一机制描述属实（`lib.rs:1113-1115`），仅帮助菜单三项是纯 Rust 动作。
- 卸载保留用户数据、重装不丢文档（`windows-user-guide.md:69`）。

## 红线自检

- 本分支只动：`apps/desktop-tauri/README.md`（修订）、新建 `docs/wave17/readme-audit.md`、
  `docs/windows-user-guide.md` 的交叉引用（最小）、`CHANGELOG.md` 顶部「未发布」段一条。
- 未改任何 `.rs / .json / .toml / .yml / .ps1` 代码或 workflow（提交后用 `git diff --stat` 复核）。
- 分支 `chore/desktop-readme-audit` 不在 `web-ci` / `release-windows` push 白名单，push 后
  无 CI run 属预期，已在 README「CI 定位」注明。
