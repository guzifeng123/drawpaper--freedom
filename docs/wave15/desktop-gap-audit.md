# Wave15 · D 路：Windows 桌面差距审计 + release-windows 冒烟补缺口

> 分支 `chore/win-smoke-gap-audit`（基线 `73cf8ad` = 0.1.0-rc.7）。
> 本路只动 `.github/workflows/release-windows.yml`、`docs/**`、以及桌面壳最小桥接
> （`apps/desktop-tauri/src-tauri/**` 的可观测性补日志、`packages/web/src/host/**`
> 浏览器路径 no-op）。大项只列单不实现；合 develop / 发版由 MainAgent 执行。
>
> 审计方法：逐条对照规划方案 §4（功能全景）/ §12（选型）中 P2/Tauri 条目与
> `docs/p2-shells.md`、`docs/p2-tauri-ci.md` 的桌面清单，**用 grep + 读源码**核对
> 当前代码现状，不照抄旧文档。证据均给文件:行号。

---

## ① 已实现项（带证据）

| 能力 | 规划出处 | 代码证据 | 行为证据 |
|---|---|---|---|
| 单实例 + argv 转发 | §4.12 / §4.9 `.kbnote` 双击关联 | `src-tauri/src/lib.rs:804-817` 单实例插件**注册在第一个**（第二实例在其余初始化前退出）；回调把 `argv[1]` 交给共享 `open_external_path` | release-windows 现有冒烟⑥：二次启动后 `drawpaper` 进程数 ==1 |
| 冷启动 argv[1] 播种 | §4.1 P2 / §4.9 P2 | `lib.rs:780-790` `maybe_seed_startup_file` → `open_external_path` | 本路新增冒烟① |
| `.kbnote` 文件关联注册 | §4.12 | `tauri.conf.json:63-72` `bundle.fileAssociations[].ext=["kbnote"]` role=Editor | 现有冒烟③：HKCU/HKLM `Classes\.kbnote` 默认值非空 |
| 最近文件列表（持久化 + 动态子菜单） | §4.1 P2 / §4.12 原生菜单与最近文件 | `lib.rs:37-39` RECENTS_CAP=10/RECENTS_FILE；`:87-137` recents_path/push_recent/persist；`:659-690` `build_open_recent_submenu`（空列表占位 + 清空最近）；`:340-353` list_recents/clear_recents | 打开/保存/双击后写 `%APPDATA%\com.drawpaper.app\drawpaper-recents.json` |
| 原生菜单全套 | §4.12 原生菜单 | `lib.rs:562-651` `build_menu`：文件（新建/打开/保存/另存/打开最近）、编辑（撤销/重做 + 原生剪切复制粘贴全选）、导出（print/pdf/png/svg/md）、视图（fit/zoom±/深色/大纲/搜索）、同步（设置）、帮助（About/检查更新/打开数据目录/主页） | 菜单项事件 → `app:menu{id}`，前端 `desktop-bridge.routeMenu` 分发 |
| 关闭守卫（脏文档拦截） | §4.9 P1 标题栏状态 / §2 三层 | `lib.rs:900-913` `CloseRequested` 拦截；`:379-399` bind_native_file/set_native_dirty/force_quit；`panels/CloseGuardDialog.tsx` 三选一 | 仅「绑定原生 .kbnote 且 dirty」才拦截，IDB 文档不拦 |
| 动态窗口标题 | §4.9 P1 | `lib.rs:371-373` set_window_title；`desktop-bridge.ts:31-34` computeWindowTitle（脏=「● 标题 — drawpaper」）；`:175-193` 订阅 doc/dirty | 现有冒烟⑤断言标题含 drawpaper |
| 拖放修复（webview 导航劫持） | §4.6 / 桌面壳 | `tauri.conf.json:24` `dragDropEnabled:false` | 拖文件进窗口不再让 webview 导航走掉 |
| CSP 锁死 | §9 隐私网络白名单 | `tauri.conf.json:28` `default-src 'self'; script-src 'self'…` | 仅 `connect-src` 放 `https:`（用户自配 AI endpoint） |
| NSIS installMode=both + 品牌位图 | §4.12 产出 Win10/11 安装包 | `tauri.conf.json:49` installMode both；`:55-56` headerImage/sidebarImage `.bmp` | 位图文件实存：`icons/installer-header.bmp`(25KB) / `installer-sidebar.bmp`(154KB) |
| `save_export`（原生 Save 对话框写盘） | §4.10 P1 直接下载 | `lib.rs:283-336` save_export（pdf/png/svg/md 过滤器 + base64 解码写盘，取消=resolved cancelled）；`tauri-host.ts:220-231` | Wave13 已接线 |
| 窗口状态记忆 | §4.12 | `lib.rs:833` `tauri-plugin-window-state`（位置/尺寸/最大化，夹到 960×600） | 纯 Rust，无 JS 命令 |
| 结构化日志 | §9 可诊断 | `lib.rs:819-830` tauri-plugin-log（Stdout + LogDir + Webview，Info） | 落 `%APPDATA%\com.drawpaper.app\logs\drawpaper.log` |
| 首次运行欢迎文档 | Wave13 | `packages/web/src/wiring/welcome-doc.ts:17-18`（id `doc_welcome_v1`、flag `drawpaper:welcome-doc-v1`）；`store/editor-store.ts:89-92` bootstrap 接线 | 本路新增冒烟②（真实 WebView2 leveldb 断言） |
| 原生通知 | §4.12 通知 | `lib.rs:483-490` notify + `tauri-plugin-notification` | 失败静默 |
| 真实文件夹自动备份（兜底快照） | §4.9 P1 自动快照 | `lib.rs:517-556` backup_doc → `app_data_dir/backups/{标题}_备份_{ts}.kbnote`，按 mtime 裁剪到 20 | Dexie 之外的磁盘兜底 |
| 视图缩放接线（死项修复） | §4.4 | `lib.rs:609-612` view:fit/zoom-in/zoom-out；`desktop-bridge.ts:104-114` → `editor/state/view-bus.ts` | Wave14 C 修复 |
| 富载荷文件打开（三入口统一） | §4.1 / §4.12 | `lib.rs:717-764` `open_external_path`（recent 菜单 / 冷启动 / 单实例热启动共用，读盘后发 `app:open-file{path,name,text,external}`） | 失败剔除 recents + 发 `app:open-file-error` |
| 安装冒烟 7 条 + 资源新鲜度 | Wave12/13 | `release-windows.yml`：①新 index-*.js 新鲜度（双架构）②静默安装+版本 ③.kbnote 注册表 ④快捷方式 ⑤启动+标题 ⑥单实例 ⑦静默卸载 | 本路一条不回退 |

---

## ② 缺失项

### 小缺口（本分支已补）

1. **`open_external_path` 成功路径无日志**（可观测性不对称）。
   现象：错误分支 `lib.rs:746` 有 `log::warn!`，但成功分支只 emit 不记日志——
   release-windows 冒烟①要靠 `drawpaper.log` 证明 Rust 收到并处理了 argv[1]，
   之前无锚点可搜。
   修补：成功分支加一行
   `log::info!("open-file (external): {path_s} (name={name})");`（`lib.rs`）。
   纯可观测性，不改行为；浏览器路径 no-op（Rust 壳不跑在浏览器）。
   三条入口（冷启动 argv / 热启动单实例 / recent 菜单）共用此 helper，均覆盖。

### 大项（仅列单，本分支不实现）

1. **冷启动 `app:open-file` 事件竞态**（已知边界）。setup() 阶段 emit 可能早于
   webview 挂载监听（`docs/wave14/desktop-open-zoom.md:70-71` 已注明「既有竞态，
   冒烟不覆盖」）。Rust 侧已读盘 / 绑定 current_path / 入 recents（本路冒烟①以
   **日志 + recents 数据目录**为证据），但画布是否实际加载该文件取决于事件是否
   赶上监听；热启动监听已就绪必达。`get_startup_file` 命令存在但前端 bootstrap
   后**未做补偿拉取**。建议后续：前端挂载后调 `get_startup_file`，非空则 loadDoc。
   属 web 启动序列改动，超出本分支「最小桥接」范围，列单。
2. **真实文件夹自动保存的 store 接线**。`choose_auto_save_dir`/`auto_save_doc`
   命令骨架在（`lib.rs:420-470`），但 `StorageAdapter` 仍走 Dexie/OPFS，未接。
   规划 §4.9 P2 增强，列单。
3. **全局快捷键**。菜单 accelerator 仅作展示文本；Ctrl+S/P/F 等由 web 侧监听，
   无系统级全局快捷键（窗口失焦时不触发）。
4. **`apps/desktop-tauri/README.md` 文档漂移**（本分支不属 `docs/**`，仅列单）：
   - 「已知未实现」仍列「系统通知」——实际已实现（notify 命令 + 插件）；
   - 出包段写 `bundle.targets = ["msi","nsis"]`——实际 `tauri.conf.json` 仅 `["nsis"]`；
   - 原生菜单「帮助」只写「关于」——实际还有检查更新/打开数据目录/项目主页。
5. **诊断包 `--diag-export`**：C 路（`feat/win-diagnostics-webview2`）功能，本分支
   不存在。本路冒烟③**显式探测 + SKIPPED 通过**（见下），合 develop 后自动转真断言。

---

## ③ 外部依赖项（代码内无法闭环）

| 依赖 | 现状 | 解锁条件 |
|---|---|---|
| 代码签名 | NSIS 未签名，首装触发 SmartScreen「未发布未知应用」（欢迎文档已引导「更多信息→仍要运行」） | OV/EV 代码签名证书 |
| 自动更新密钥 | `tauri-plugin-updater` **故意未启用**（Cargo.toml 注释 + `docs/p2-tauri-ci.md §3`）；无 `TAURI_SIGNING_PRIVATE_KEY`、无 `latest.json` 托管 | `tauri signer generate` → 公钥入 conf / 私钥入 Secrets / release 出 `.sig` / 托管 latest.json |
| iOS | 未做（`docs/p2-tauri-ci.md §6`） | Apple Developer 账号 + 签名证书 + macOS runner |
| 真机人工走查 | 画布实际内容断言（冷启动双击后块是否渲染）无法在 CI 无 UI 自动化下稳定做 | 人工 Windows 走查 / 引入 WebView2 UI 自动化 |
| WebView2 运行时分发 | 当前走系统 Evergreen Runtime（Win11 自带；Win10 需手动），安装包小 | 若要离线/固定版分发需内置 WebView2 bootstrapper，体积增大 |

---

## 冒烟补三条（release-windows.yml，x64 实跑；arm64 门控同现有惯例 skip）

> 三条新步骤均 `if: matrix.arch == 'x64'`、带 `timeout-minutes`、有界轮询、
> 每步末尾显式清理 drawpaper + 其 WebView2 子进程，绝不裸 `-Wait` 挂死。
> 现有 7 条断言 + 资源新鲜度检查**一条不动、不回退**。

1. **冷启动文件关联**（`...\Temp\<guid>.kbnote` 含唯一金丝雀 → `drawpaper.exe <path>`）：
   有界轮询断言进程存活、主窗口标题含 drawpaper；再断言日志出现 `open-file` + 金丝雀文件名、
   且 recents 文件含该路径（数据目录断言）。**路径不写死**：`app_log_dir` 与 `app_config_dir`
   在 Tauri/Windows 上可能落在 Roaming（`%APPDATA%`）或 Local（`%LOCALAPPDATA%`）的
   `com.drawpaper.app`，冒烟同时搜两个根、复制日志副本再读（防 appender 占用）、每轮打印诊断，
   并 dump 实际数据目录树。画布内容断言为边界，文档注明。
2. **首次运行欢迎文档**：清空 app 数据目录后冷启动 → 有界等 EBWebView leveldb 命中
   `doc_welcome_v1` / `drawpaper:welcome-doc-v1` 并打印命中；第二次启动断言命中数不增。
3. **诊断包探测**：`drawpaper.exe --diag-export <zip>`，有界等 zip。本分支无此功能 →
   超时无 zip 即打印 `SKIPPED: diagnostics feature not in this branch, activates after C merges`
   并 exit 0（不假绿、不失败）；合 C 后自动转真断言（zip 存在、不含 .kbnote 正文）。

## 门禁

- Linux 无 cargo：Rust 以 release-windows 实跑为准。
- 本地：YAML 解析 + 结构断言、`pnpm -r build`。本路未动 web 业务代码（仅 Rust 一行
  日志 + workflow + docs），web typecheck/lint/单测/e2e 不回退（基线 rc.7：
  core≈300 / web≈326 / e2e≈102+1skip / 离线 4，以实际为准）。
