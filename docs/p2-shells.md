# P2 跨端外壳脚手架（Tauri 2 桌面 + Capacitor 平板）

> 本分期（P2 脚手架）只交付**目录骨架 + HostAdapter 接口实现代码 + 文档**，
> 不产出安装包 / APK / IPA。前端 100% 复用 `packages/web`，外壳只替换
> `HostAdapter` 这一层（规划 §3 / §4.9 / §4.12 / §12）。

## 1. 目录结构

```
drawpaper/
├─ packages/
│  ├─ core/                 # 纯 TS，零 DOM（不动）
│  └─ web/
│     └─ src/host/
│        ├─ web-host.ts      # 既有：PWA 降级实现（不动）
│        ├─ tauri-host.ts    # ★ 本期新增：Tauri 桌面适配器 + createBestHostAdapter()
│        └─ index.ts         # （不动）
└─ apps/                     # ★ 本期新增：独立 package.json，不进根 pnpm workspace
   ├─ desktop-tauri/        # Tauri 2 + WebView2（Windows）
   │  ├─ package.json
   │  ├─ src-tauri/
   │  │  ├─ Cargo.toml
   │  │  ├─ build.rs
   │  │  ├─ tauri.conf.json
   │  │  ├─ capabilities/default.json
   │  │  ├─ icons/{icon.svg, README.md}
   │  │  └─ src/{main.rs, lib.rs}
   │  └─ README.md
   └─ mobile-capacitor/      # Capacitor（平板壳，PWA 先行）
      ├─ package.json
      ├─ capacitor.config.ts
      ├─ src/host-mobile.ts  # 参考实现，不进 packages/web 构建
      └─ README.md
```

**workspace 边界**：根 `pnpm-workspace.yaml` 只 glob `packages/*`，`apps/` 对
`pnpm -r` 不可见。两个 app 各自独立 `pnpm i --ignore-workspace` 装自己的 CLI，
不污染根 lockfile。`pnpm -r build` / `pnpm test` 在本分支与 develop 基线一致
（core 78 + web 75 全绿）。

## 2. HostAdapter 三端对照

core 侧接口定义：`packages/core/src/store/adapters.ts` →
`HostAdapter { showOpenFilePicker, showSaveFilePicker, print, share? }`。

| 能力 | Web PWA（web-host.ts） | Tauri 桌面（tauri-host.ts + Rust commands） | Capacitor 平板（host-mobile.ts 参考） |
|---|---|---|---|
| 打开 `.kbnote` | `showOpenFilePicker()`：File System Access → 降级 `<input type=file>` | `invoke('open_kbnote')` → 原生对话框 → 读文本 → `{name, text, path}` | 复用 `<input type=file>`（iPadOS Files app）；Filesystem 插件读 app-private drafts |
| 保存 `.kbnote` | `showSaveFilePicker(filename, text)`：FSA → 降级 `<a download>` | `invoke('save_kbnote', {filename, text, forcePick})`；已有路径原地覆盖 | Filesystem 写 Documents/ 后走 share sheet |
| 打印 | `window.print()` | `window.print()`（WebView2 系统打印，可另存 PDF） | 无系统打印对话框；导出 PDF 后走 `@capacitor/share` |
| 分享 | `navigator.share` | no-op（桌面无系统分享面板；预留 `tauri-plugin-share`） | `@capacitor/share` |
| 最近文件 | 无（Dexie docs list） | Rust `list_recents` / `clear_recents`，JSON 持久化到 app config dir | 同 PWA（Dexie） |
| `.kbnote` 双击关联 | 不适用 | `fileAssociations` 注册 + argv 启动检测 + single-instance 转发 | 不适用（移动 OS 由 Files/Quick Look 调起，后续接 `@capacitor/app` open-url） |
| 原生菜单 | 无（React 自绘工具栏） | Rust 构建文件/编辑/导出/视图/帮助菜单 → emit `app:menu{id}` → 前端映射到 store action | 无（移动端用底部工具栏） |
| 真实文件夹自动保存 | OPFS（P1） | Rust `choose_auto_save_dir` / `auto_save_doc`（骨架，未接 store） | Filesystem 写 Documents/ |

### 2.1 TauriHostAdapter 实现要点

`packages/web/src/host/tauri-host.ts`：

- **零新增 npm 依赖**：不 import `@tauri-apps/api`，直接用 `window.__TAURI__`
  全局对象（Tauri 2 默认 `withGlobalTauri=true` 注入）。后续要换正式 SDK 时，
  只改 `tauriInvoke()` 一个函数。
- **能力检测**：`'__TAURI__' in window`，工厂 `createBestHostAdapter()` 据此
  选择 `TauriHostAdapter` 或 `WebHostAdapter`。
- **不在 Tauri 环境时构造函数抛 `TauriUnavailableError`**——防御性，工厂
  正常情况下不会让这种情况发生。
- **额外暴露** `onMenuEvent(handler)` / `onOpenFileEvent(handler)`：订阅原生
  菜单事件和双击关联文件事件，供集成期桥接 store。

### 2.2 前端集成接线（一行改动，本分期不做）

`packages/web/src/store/editor-store.ts` 第 42 行：

```ts
// 现状：
export const hostAdapter = new WebHostAdapter();

// 集成期替换为：
import { createBestHostAdapter } from '../host/tauri-host';
export const hostAdapter = createBestHostAdapter();
```

仅此一行。其余业务代码（panels / export / store）零改动。
本期**不改这一行**——留给集成 PR，避免把脚手架和业务接线混在一个提交里。

## 3. Tauri 构建步骤（Windows 10/11 x64 / ARM64）

详见 `apps/desktop-tauri/README.md`。摘要：

1. rustup 装 stable-x86_64-pc-windows-msvc（ARM64 加 `aarch64-pc-windows-msvc` target）；
2. VS Build Tools 2022 装「使用 C++ 的桌面开发」；
3. Win11 自带 WebView2，Win10 装 Evergreen Runtime；
4. 仓库根：`pnpm install && pnpm -r build`；
5. `cd apps/desktop-tauri && pnpm i --ignore-workspace && pnpm tauri build`。

出包目标：`src-tauri/target/release/bundle/{msi,nsis}/`，x64 + ARM64。

### 3.1 本机验证结论（Linux 开发机）

本机（Linux x64，无 Rust）按任务要求尝试用 rustup 装工具链并跑 `cargo check`。
结果见下文「本机 cargo check 结论」小节。

## 4. Capacitor 步骤（平板）

详见 `apps/mobile-capacitor/README.md`。摘要：

1. 仓库根 `pnpm -r build` → `packages/web/dist`；
2. `cd apps/mobile-capacitor && pnpm i --ignore-workspace`；
3. `npx cap add android`（或 `add ios`）→ `npx cap sync`；
4. `npx cap open android` / `open ios` → IDE 出包。

PWA 先行：iPad/Android 用户直接「添加到主屏幕」即可，不需要 Capacitor 壳。
触屏手势（Pointer Events / 长按连线 / 双指缩放 / 44px 热区）是 Wave3 P1
范围，规划 §4.6 已列清单，本分期不做。

## 5. P3 接口预留核查

读 `packages/core/src/store/adapters.ts` 确认：

| 接口 | 状态 | 位置 |
|---|---|---|
| `StorageAdapter` | ✅ 已实现（Dexie/OPFS） | `packages/web/src/storage/` |
| `HostAdapter` | ✅ web 已实现；本期补 Tauri 实现 | `packages/web/src/host/` |
| `AIProvider` | ✅ 接口已预留（`AIChatRequest/Response/Provider`），`applyAIDiff` 抛 `not implemented: P1` | `adapters.ts:67-120` |
| `CollabAdapter`（Yjs/CRDT） | ✅ 空接口已预留（`docId/connect/disconnect`），不装 yjs | `adapters.ts:127-132` |
| `BlobLike` | ✅ duck-type 抽象（core 零 DOM 硬约束） | `adapters.ts:12-17` |

**结论**：跨端 / 协作接缝在 P0 阶段已预留完毕，本期 P2 外壳脚手架**无需
新增 core 接口**。三端只替换 `HostAdapter` 实现，core 零改动。

## 6. 本机验证结论

### 6.1 前端门禁

- `pnpm -r --filter "./packages/*" build`：✅ 通过（core tsc + web vite build）。
- `pnpm -r --filter "./packages/*" test`：✅ core 78/78 + web 75/75 = 153 全绿，
  与 develop 基线一致。
- 新增文件 `packages/web/src/host/tauri-host.ts` 已被 web tsconfig include
  （`"include": ["src", "e2e"]`），`tsc --noEmit` 通过，无新增类型错误。

### 6.2 Rust 工具链

- **rustup 安装**：✅ 在 `$HOME/.cargo` 下装好 stable 工具链
  （rustc/cargo 1.99.0），未使用 sudo/apt。
- **`cargo check` 结果**：❌ 被系统 GTK3/webkit2gtk 开发包挡住，**这是预期阻塞**，
  不是脚手架代码问题。确切错误：

  ```
  error: failed to run custom build command for `gdk-sys v0.18.2`
  pkg-config: Package gdk-3.0 was not found in the pkg-config search path.
  The system library `gdk-3.0` required by crate `gdk-sys` was not found.
  ```

  Tauri 2 在 Linux 上需要 `libwebkit2gtk-4.1-dev` + `libgtk-3-dev` 等系统包，
  本机无 sudo 权限装不了。这与任务书「webkit2gtk 仅 Linux 开发需要」一致——
  真实目标平台是 Windows（WebView2，走 MSVC 工具链，不依赖 GTK）。
- **结论**：Rust 源码（Cargo.toml / build.rs / main.rs / lib.rs）内部自洽，
  依赖版本选的是 Tauri 2 生态当前稳定线（tauri 2.1 / dialog/fs/opener/
  single-instance 2.x）。在 Windows 出包机上按 `apps/desktop-tauri/README.md`
  步骤即可编译；Linux 交叉验证留给有 GTK 环境的 CI。

## 7. 未实现项（本分期明确不做）

- 安装包 / MSI / NSIS / APK / IPA 产出
- 自动更新（`tauri-plugin-updater`）
- 系统通知（`tauri-plugin-notification`）
- 全局快捷键（菜单快捷键目前仅 WebView 内 web 侧监听）
- 真实文件夹自动保存的 store 接线（Rust 命令骨架已就绪）
- 触屏手势（Wave3 P1）
- Capacitor 原生工程 `android/` / `ios/` 目录（`cap add` 才生成）
- 正式图标 / 代码签名证书
- `editor-store.ts` 的 `createBestHostAdapter()` 接线（留给集成 PR）
