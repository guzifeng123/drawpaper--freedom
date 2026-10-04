# drawpaper · Windows 桌面壳（Tauri 2）

本目录是 drawpaper 的 Windows 桌面外壳。**前端完全复用 `packages/web`**，
这里只放 Rust 壳、菜单、文件对话框、`.kbnote` 双击关联和打包配置。

> 选型依据：规划文档 §12 — Tauri 2（MIT/Apache-2.0）+ WebView2，安装包 ~10MB
> 量级，原生菜单/系统打印/真实 FS 完整。不选 Electron（体积大）。

## 目录

```
apps/desktop-tauri/
├─ package.json             # 独立 package.json，不进根 pnpm workspace
├─ .gitignore
├─ README.md                # 本文件
└─ src-tauri/
   ├─ Cargo.toml            # Rust 依赖（tauri 2.x + dialog/fs/opener/single-instance）
   ├─ build.rs
   ├─ tauri.conf.json       # productName/identifier/windows/bundle/fileAssociations
   ├─ capabilities/
   │  └─ default.json       # 最小权限：dialog/fs/window/menu/event
   ├─ icons/                # 占位 icon.svg；正式图标用 `pnpm tauri icon` 生成
   └─ src/
      ├─ main.rs            # 薄入口，调 lib::run()
      └─ lib.rs             # 菜单、commands（open/save/print/recents/双击关联）
```

## 前置依赖（Windows 10/11 x64 或 ARM64）

| 组件 | 版本 | 说明 |
|---|---|---|
| Rust 工具链 | stable ≥ 1.77 | `winget install Rustlang.Rustup`，然后 `rustup default stable-x86_64-pc-windows-msvc`（ARM64 用 `aarch64-pc-windows-msvc`） |
| Visual Studio Build Tools | 2022 | 安装「使用 C++ 的桌面开发」工作包（MSVC + Windows 11 SDK） |
| WebView2 Runtime | 自带于 Win11；Win10 需手动装 Evergreen 运行时 | Tauri 2 不打包 WebView2，走系统自带 |
| Node.js | ≥ 20 | 与根仓库一致 |
| pnpm | 11.x | 根仓库 `packageManager` 字段锁定 |

> Linux 开发机额外需要 `webkit2gtk-4.1` 等系统库（见 Tauri 官方 prerequisites）；
> 本项目目标平台是 Windows，Linux 仅作交叉编译验证用。

## 开发运行

```powershell
# 1. 在仓库根（worktree 根）安装前端依赖并跑通 web dev
cd <repo-root>
pnpm install
pnpm --filter @drawpaper/web dev      # 确认 http://localhost:5173 可开

# 2. 本目录装 Tauri CLI（独立装，不污染根 workspace）
cd apps/desktop-tauri
pnpm install --ignore-workspace

# 3. 启动桌面壳（会自动 beforeDevCommand 拉起 web vite）
pnpm tauri dev
```

`tauri.conf.json` 里：

- `beforeDevCommand`: `pnpm --filter @drawpaper/web dev`
- `devUrl`: `http://localhost:5173`
- `beforeBuildCommand`: `pnpm --filter @drawpaper/web build`
- `frontendDist`: `../../packages/web/dist`

## 出包（MSI / NSIS）

```powershell
# 先在根目录构建前端到 packages/web/dist
pnpm -r --filter "./packages/*" build

# 再回到本目录出包
cd apps/desktop-tauri
pnpm tauri build                  # 同时打 msi + nsis
pnpm tauri build --bundles msi    # 只 MSI
pnpm tauri build --bundles nsis   # 只 NSIS
```

产物在 `src-tauri/target/release/bundle/{msi,nsis}/`。
当前 `bundle.targets` 仅声明 `["msi", "nsis"]`，架构由 Rust target 决定
（x64 默认；ARM64 需 `rustup target add aarch64-pc-windows-msvc` 后交叉编译）。

## 原生菜单

菜单在 `src-tauri/src/lib.rs::build_menu` 中构建，覆盖：

- **文件**：新建 / 打开 / 保存 / 另存为 / 打开最近 / 清空最近
- **编辑**：撤销 / 重做
- **导出**：打印（另存为 PDF）/ 直接下载 PDF
- **视图**：适应屏幕 / 放大 / 缩小
- **帮助**：关于

菜单项点击后 Rust 不直接做副作用，而是 `app.emit("app:menu", {id})`
推给前端；前端在 React 侧把 id 映射到 zustand action（undo/redo/fit/print-mode）。
这样所有业务逻辑仍在 packages/web，Rust 只负责「菜单存在」这件事。

## `.kbnote` 双击关联

`tauri.conf.json` → `bundle.windows.fileAssociations` 把 `.kbnote` 后缀注册到本应用。
启动时 `lib.rs::maybe_seed_startup_file` 读 `argv[1]`，若指向一个存在的 `.kbnote`
就塞进 `AppState.current_path` 并 `emit("app:open-file", {path})`。
单实例插件 (`tauri-plugin-single-instance`) 保证：应用已在跑时，第二次双击会把
路径转发给已运行实例而不是再起一个进程。

## HostAdapter 命令清单（前端 tauri-host.ts 对应）

| Tauri command | 前端调用 | 语义 |
|---|---|---|
| `open_kbnote` | `showOpenFilePicker()` | 原生打开对话框 → 返回 `{name, text, path}` |
| `save_kbnote(filename, text, force_pick?)` | `showSaveFilePicker()` | 已有路径原地覆盖；`force_pick=true` 走另存为对话框 |
| `print` | `print()` | emit `app:menu{id:"export:print"}`，前端切打印态再 `window.print()` |
| `list_recents` / `clear_recents` | （文档列表面板） | 最近文件 JSON 持久化在 app config dir |
| `get_startup_file` | 启动时探测 | 返回双击关联的 `.kbnote` 路径或 null |
| `choose_auto_save_dir` / `auto_save_doc` | （P2 增强，未接线） | 真实文件夹自动保存骨架 |

## 已知未实现（本分期只做脚手架）

- 自动更新（`tauri-plugin-updater`）— 留给 P2 收尾
- 系统通知（`tauri-plugin-notification`）
- 全局快捷键（菜单快捷键目前仅在 WebView 里由 web 侧监听 Ctrl+S/P 等）
- 真实文件夹自动保存的 store 接线（命令已就绪，StorageAdapter 替换未做）
- 正式图标 / 代码签名证书
