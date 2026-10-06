# Wave 13 · Windows 桌面端原生缺口（A 路冻结的 Rust 命令契约）

> 阶段 A 负责：冻结 Windows 桌面端 Rust 命令契约并落地六项原生缺口。
> 本文档是 **B 路（前端）接线的唯一权威**。Rust 侧已按本契约实现；B 路照此接线即可，
> 不需要再读 Rust 源码。本文件只描述**契约**，前端业务逻辑仍在 `packages/web/`。
>
> 红线：未改版本号（`Cargo.toml [package].version` 与 `tauri.conf.json` 一字未动），
> 未改 `.github/workflows/`，未改 `packages/web/`。

六项清单：

1. `save_export` 命令：原生 Save 对话框 + Rust 写盘（PDF/PNG/SVG/MD）。
2. `tauri-plugin-window-state`：窗口位置/尺寸/最大化记忆恢复。
3. `tauri-plugin-log`：`drawpaper.log` 写 app 目录、info 级、webview error/panic 转发。
4. 文件→打开最近：原生动态子菜单（路径项 + 分隔线 + 清空最近），实时重建。
5. 帮助菜单：检查更新 / 打开数据目录 / 原生 About。
6. 另存为 `Ctrl+Shift+S` accelerator + capabilities 最小权限补齐。

---

## 1. `save_export` 命令契约（已冻结）

前端用 `window.__TAURI__.core.invoke('save_export', args)` 调用（与现有
`open_kbnote` / `save_kbnote` 同一条通道）。

### 请求参数（object，camelCase）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `suggestedName` | `string` | 默认文件名（不含或含扩展名均可，Rust 会补/对齐扩展名）。一般用文档标题，如 `我的画布`。 |
| `ext` | `string` | 导出类型，**小写**：`"pdf"` \| `"png"` \| `"svg"` \| `"md"`（`"markdown"` 也接受）。 |
| `bytesBase64` | `string` | 导出字节的标准 base64（无换行、`+`/`/` 标准字母表、无 padding 要求——Rust 用标准解码器，带 padding 也能解）。PDF=位图模式导出的字节；PNG/SVG/MD 同理。 |

> 注意：Tauri invoke 参数是 camelCase ↔ Rust snake_case 的自动映射。
> Rust 形参是 `suggested_name / ext / bytes_base64`，前端传 **`suggestedName / ext / bytesBase64`**。

### 返回值（联合类型，前端 `switch (outcome.status)`）

```ts
type ExportSaveOutcome =
  | { status: 'saved'; path: string }     // 用户选了路径且 Rust 写盘成功；path=绝对路径
  | { status: 'cancelled' };               // 用户取消了原生 Save 对话框——不是错误，不要 toast 报错
```

- 取消对话框：resolve `{ status: 'cancelled' }`，**不 reject**。与 web 端
  `showSaveFilePicker` 取消语义一致——前端应静默忽略，不弹错误。
- 写盘失败 / base64 解码失败 / 未知 ext：`reject(string)`（人类可读错误），前端 toast。
- `ext` 不在四类内：`reject("unsupported ext: …")`。

### 四类扩展名与对话框过滤器

| `ext` | Save 对话框过滤器名 | 扩展名 |
| --- | --- | --- |
| `pdf` | `PDF 文档` | `*.pdf` |
| `png` | `PNG 图片` | `*.png` |
| `svg` | `SVG 图片` | `*.svg` |
| `md` | `Markdown 文档` | `*.md; *.markdown` |

默认文件名会自动补上对应扩展名。**Ctrl+P 的浏览器打印管线不动**（`export:print`
仍走前端打印 CSS + `window.print()`）；本命令只服务“直接下载 PDF / PNG / SVG / MD”
这四个导出动作在桌面端的落盘。

---

## 2. 菜单项 id 全量清单

所有原生菜单项点击后，除下方标注「Rust 自取」的项外，都会 emit
`app:menu` 事件，payload `{ id: string }`（与现有 `onMenuEvent` 通道完全一致）。
前端 `routeMenu(id)` 照此分发。

### 文件
| id | 标签 | accelerator | 说明 |
| --- | --- | --- | --- |
| `file:new` | 新建画布 | — | emit `app:menu` |
| `file:open` | 打开… | `Ctrl+O`（标签内嵌） | emit `app:menu` |
| `file:save` | 保存 | `Ctrl+S`（标签内嵌） | emit `app:menu` |
| `file:save-as` | 另存为… | **`Ctrl+Shift+S`（真实 accelerator，Wave13 新增）** | emit `app:menu` |
| — | 分隔线 | | |
| **`打开最近`（真子菜单）** | | | 见 §4 |

> 旧的顶层 `file:open-recent` / `file:clear-recent` 两个纯文本项已**移除**，
> 功能并入「打开最近」动态子菜单（§4）。前端 `routeMenu` 里针对这两个 id 的
> `default` 分支可删。

### 编辑
`edit:undo`(`Ctrl+Z`) / `edit:redo`(`Ctrl+Shift+Z`) / 分隔线 / 剪切 / 复制 / 粘贴 / 全选
（后四个是 `PredefinedMenuItem`，WebView2 原生处理，不经前端）。

### 导出
`export:print`(`Ctrl+P`) / `export:pdf` / `export:png` / `export:svg` / `export:md`
（全部 emit `app:menu`，前端 `runExportAction(...)`）。

### 视图
`view:fit`(`Ctrl+0`) / `view:zoom-in`(`Ctrl+=`) / `view:zoom-out`(`Ctrl+-`) / 分隔线 /
`view:dark-mode` / `view:outline` / `view:search`(`Ctrl+F`)。

### 同步
`sync:settings`。

### 帮助（见 §5）
- `关于 drawpaper`：`PredefinedMenuItem::about`（原生对话框，**Rust 自取，不经前端**）。
- `help:check-update`：检查更新…（**Rust 自取**，opener 打开 releases/latest）。
- `help:open-data-dir`：打开数据目录（**Rust 自取**，reveal 数据目录）。
- 分隔线。
- `help:home`：项目主页（**Rust 自取**，opener 打开仓库首页）。

---

## 3. 「打开最近」动态子菜单与打开方案（已冻结）

文件→打开最近 是一个**真子菜单**，内容来自 Rust `AppState.recents`
（与现有 `list_recents` / `clear_recents` 命令、`drawpaper-recents.json` 同一数据源）。

### 子菜单结构
- 前 N 项（N ≤ 10）：每个最近文件一项，**id = `recent:<n>`**（`n` = 在 recents 中的下标，
  0 = 最近一次打开）。标签显示**文件名**（取路径 basename）。
- 一条分隔线。
- 末尾「清空最近」：**id = `recent:clear`**（列表为空时该项禁用）。
- 列表为空时：子菜单内放一个禁用占位项 `recent:empty`（标签「（无）」），其后仍跟禁用的「清空最近」。

### 增删改后实时重建
每次 open / save / clear（包括双击关联、单实例转发）改动 recents 后，Rust 会
**整体重建菜单并 `set_menu`**。重建保留全部既有静态项与 accelerator，不丢。
前端浏览器端自己的最近列表**不动**，两者共享同一份持久化 JSON。

### 点击 `recent:<n>` 的打开方案（B 路据此接线）
**Rust 自取内容并 emit 富 `app:open-file` 事件**——不绕前端弹对话框，也不要求前端
自己读盘（webview 没有任意路径读权限）。Rust 行为：

1. 按 `n` 取 recents 路径；读 `.kbnote` 文本。
2. 成功：把该路径提到最前（push_recent，触发菜单重建）、写入 `current_path`
   （下次保存原地覆盖），然后 emit：
   ```jsonc
   // event: "app:open-file"
   { "path": "<绝对路径>", "name": "<文件名.kbnote>", "text": "<文件内容>", "external": true }
   ```
3. 失败（文件被移动/删除）：Rust 记 `warn!` 日志、把该过期项从 recents 剔除、持久化、
   重建菜单——**不 emit、不 toast**（该项直接消失）。

**B 路接线约定**：扩展现有 `onOpenFileEvent`（`packages/web/src/host/tauri-host.ts`
里已定义、尚未接线的那个 listener）：监听 `app:open-file`，payload 为
`{ path, name?, text?, external? }`。当 `text` 是字符串时，走与 `file:open` 成功分支
完全相同的加载路径：`parseKBNote(text)` → `loadDoc(doc)` → `bindNativeFile(path)`。
（这与 `desktop-bridge.ts` 里 `case 'file:open'` 的成功分支一致。）

> 兼容说明：单实例第二实例转发、双击启动这两条既有路径仍 emit **仅含 `{path, external}`**
> 的 `app:open-file`（不带 `text`）。B 路在 `text` 缺失时按既有降级处理即可——
> 本次 A 路不改动这两条路径的 payload 形状。

### `recent:clear`
Rust 自取：清空 recents、持久化、重建菜单。前端无需响应（也可顺手同步自己的列表）。

---

## 4. 帮助菜单三项

| id | 行为 | 网络 |
| --- | --- | --- |
| `关于 drawpaper` | 原生 `PredefinedMenuItem::about` 对话框：名称 drawpaper、版本 `CARGO_PKG_VERSION`、中文描述、authors、homepage=仓库地址。 | 无 |
| `help:check-update` | opener 打开 `https://github.com/guzifeng123/drawpaper--freedom/releases/latest` | **仅点击时一次** |
| `help:open-data-dir` | opener `reveal_item_in_dir(app_data_dir)` 在资源管理器中打开数据目录 | 无 |
| `help:home` | opener 打开仓库首页（既有） | 仅点击时一次 |

**零后台网络声明**：检查更新**没有任何**定时轮询、启动自检查、后台请求；
不引入 `tauri-plugin-updater`（见 Cargo.toml 顶部注释：无签名密钥与 latest.json）。
唯一的外发网络就是用户手动点「检查更新」/「项目主页」时打开浏览器。

---

## 5. capabilities diff

文件：`apps/desktop-tauri/src-tauri/capabilities/default.json`，在原权限列表末尾**新增一行**：

```diff
   "notification:allow-request-permission",
+  "log:default"
 ]
```

- `log:default`：允许 webview 通过 `@tauri-apps/plugin-log` 写日志（Webview target 转发需要）。
- `tauri-plugin-window-state`：**纯 Rust 侧**，不暴露任何 JS 命令，**无需新增权限**。
- `save_export` 用 Rust 侧 `DialogExt` + `std::fs::write`，不经 fs/dialog 的 JS 命令通道，
  故无需额外 `dialog:*` / `fs:*` 权限（既有 `dialog:allow-save` 等保留不动）。

---

## 6. 插件配置与日志路径

### Cargo.toml 新增（仅官方插件 + 一个解码依赖）
```toml
tauri-plugin-window-state = "2.0"   # 窗口位置/尺寸/最大化记忆
tauri-plugin-log = "2.0"             # 文件+stdout+webview 日志
base64 = "0.22"                      # save_export 解码前端传来的导出字节
```
同时**移除** `env_logger = "0.11"`（被 tauri-plugin-log 取代为全局 logger；
二者不能同时注册，否则 setup 时 panic）。`log = "0.4"` 保留。

### window-state
```rust
.plugin(tauri_plugin_window_state::Builder::default().build())
```
默认 StateFlags（位置/尺寸/最大化），恢复时按 `tauri.conf.json` 的
`minWidth: 960 / minHeight: 600` 夹紧。最小尺寸约束不变。

### log
```rust
tauri_plugin_log::Builder::new()
    .level(log::LevelFilter::Info)
    .targets([
        Target::new(TargetKind::Stdout),                                  // 保留控制台输出
        Target::new(TargetKind::LogDir { file_name: Some("drawpaper") }), // drawpaper.log
        Target::new(TargetKind::Webview),                                 // webview→Rust 日志/panic 转发
    ])
    .build()
```
- 日志文件：**`drawpaper.log`**，落在 app log 目录
  （Windows 上即 `%APPDATA%\com.drawpaper.app\logs\drawpaper.log`）。
- 级别：Info。滚动：插件默认（KeepOne，单文件约 40KB 上限后轮转）。
- webview 的 `console.error` / panic 经 Webview target 汇入同一日志管线；
  前端如需把浏览器 console 接入，B 路可 `import { attachConsole } from '@tauri-apps/plugin-log'`
  （可选，不影响 Rust 侧）。

---

## 7. 遗留 / 交接给 B 路

- `onOpenFileEvent`（`tauri-host.ts` 已定义未接线）需在 `initDesktopBridge` 里订阅，
  按 §3 富 payload（`text` 存在则直接加载）处理 `recent:<n>` 打开与单实例/双击转发。
- 四个导出动作（`export:pdf/png/svg/md`）目前走浏览器下载；B 路在桌面端可改调
  `save_export` 实现原生落盘（参数见 §1）。`export:print` 不动。
- `routeMenu` 中 `file:open-recent / file:clear-recent` 的 `default` 分支已失效，可删。
- 窗口状态、日志、About 均为 Rust 自闭环，无需前端接线。
