# Wave12 A 路：Windows Tauri 桌面外壳打磨

基线 `cd97f6a`（= Wave11 收尾 + CI 触发提交），分支 `feat/desktop-shell-polish`。
本波七项收尾：拖放修复、CSP 放行局域网 http、动态窗口标题、原生关闭守卫、
菜单补全、NSIS 打磨、capabilities 最小权限复核。验收权威是
`release-windows` 工作流在本分支的真实 Windows 构建（MSI 已下线，只出 NSIS 安装包）。

## 1. 拖放修复（dragDropEnabled=false）

WebView2 默认在窗口级吞掉 HTML5 拖放事件（dragover/drop），导致 Wave6 把
图片/文本块直接拖进画布的功能在 exe 里整体失效——浏览器里正常、打包后失效。

`tauri.conf.json` 窗口配置：

```diff
- "dragDropEnabled": true
+ "dragDropEnabled": false
```

应用自身不做原生文件拖放托管（打开/保存走菜单对话框），所以关掉 Tauri 的
原生拖放后，dragover/drop 事件原样落到网页层，画布的 HTML5 拖放恢复工作。

## 2. CSP 放行局域网 http（仅 connect-src）

用户自配的 WebDAV / AI 兼容端点可能跑在局域网 `http://192.168.x.x:port`（家用
NAS、本地 Ollama）。原 CSP `connect-src 'self' https://*` 把 http: 全挡了。

```diff
- connect-src 'self' https://*
+ connect-src 'self' https: http:
```

只改 connect-src 一条，其余指令（default/style/font/img/script）一字未动。
`https:` 是对 `https://*` 的等价收紧写法（scheme 源，不携带 host 通配）。
tauri.conf.json 是严格 JSON 不支持注释，此说明即注释。

## 3. 动态窗口标题

新增 Rust 命令 `set_window_title(title)`，前端 `TauriHostAdapter.setWindowTitle()`
在 App 挂载后订阅 editor-store（doc.title / dirty / saveState 任一变化）推送：

| 状态 | 标题 |
| --- | --- |
| 有文档且脏 | `● {文档名} — drawpaper` |
| 有文档且干净 | `{文档名} — drawpaper` |
| 无文档 | `drawpaper` |

纯函数 `computeWindowTitle(title, dirty)` 导出在 `host/desktop-bridge.ts`，
单测覆盖三种格式。浏览器环境 `initDesktopBridge()` 检测不到 `__TAURI__`
直接短路，标题调用为 no-op。

## 4. 原生关闭守卫

三个 Rust 命令 + 窗口事件拦截：

- `bind_native_file(path: Option<String>)`：前端在「原生打开 .kbnote 成功」时
  绑定 Some(path)；切到 IDB 文档/新建时传 None。
- `set_native_dirty(bool)`：前端订阅 store.dirty 实时上报。
- `force_quit()`：翻 dirty=false 后 `app.exit(0)`，绕过守卫退出。

Builder 注册 `on_window_event`：仅当「已绑定原生文件 且 dirty」时
`api.prevent_close()` 并 emit `app:close-requested`。前端弹三选
`CloseGuardDialog`（保存并退出 / 不保存 / 取消）：

- 保存并退出 → 原地覆盖 .kbnote（`save_kbnote` 因 Rust 端已记 current_path
  而原地写盘）→ `force_quit()`；用户在保存对话框里取消 → 留在应用。
- 不保存 → 直接 `force_quit()`。
- 取消 → 关弹窗，留在应用。

未绑定原生文件（IDB 文档）关闭不拦——IndexedDB 自动保存是兜底。

## 5. 菜单补全

Rust `build_menu()` 补项，菜单事件除「帮助→项目主页」外全部 emit `app:menu`
推给前端，前端在 `host/desktop-bridge.ts` 的 `routeMenu()` 分发：

| 菜单 | id | 前端动作 |
| --- | --- | --- |
| 文件→新建 | `file:new` | store.newDoc() |
| 文件→打开… | `file:open` | 原生对话框读 .kbnote → parseKBNote → loadDoc → bind |
| 文件→保存 | `file:save` | requestSave + 原地写 .kbnote → setNativeDirty(false) |
| 文件→另存为… | `file:save-as` | forcePick 弹另存对话框 |
| 编辑→撤销/重做 | `edit:undo` / `edit:redo` | store.undo/redo |
| 编辑→剪切/复制/粘贴/全选 | PredefinedMenuItem 原生角色 | WebView2 对聚焦 contenteditable 原生处理，前端不接线 |
| 导出→打印/PDF/PNG/SVG/Markdown | `export:print/pdf/png/svg/md` | export-actions-bridge 注册表转发到 useExportModel 五个既有动作 |
| 视图→深色模式 | `view:dark-mode` | useThemeStore 按 resolved 切 light/dark |
| 视图→大纲面板 | `view:outline` | setOutlineOpen 切换 |
| 视图→搜索… | `view:search` | setSearchOpen(true) |
| 同步→同步设置… | `sync:settings` | setSyncOpen(true)（复用 open-sync 同一路径） |
| 帮助→项目主页 | `help:home` | Rust 侧直接 `opener().open_url(github.com/guzifeng123/drawpaper--freedom)`，不经前端 |

`file:open-recent` / `file:clear-recent` / `view:fit` / `view:zoom-in/out`
保留既有菜单项，前端暂不接线（emit 后默认分支忽略），后续波次再补。

## 6. NSIS 打磨

```diff
  "bundle": {
-   "targets": ["msi", "nsis"],
+   "targets": ["nsis"],
    "windows": {
-     "wix": { "language": ["zh-CN", "en-US"] },
      "nsis": {
+       "installMode": "currentUser",
+       "displayLanguageSelector": true,
        "languages": ["SimpChinese", "English"],
+       "headerImage": "icons/installer-header.bmp",
+       "sidebarImage": "icons/installer-sidebar.bmp"
      }
    }
  }
```

- MSI/WiX 整条移除（targets 只剩 nsis，wix 配置成死配置）。
- `installMode: currentUser`：免 UAC 装到用户目录，配合文件关联更顺。
- `displayLanguageSelector: true`：安装首屏选简体中文/English。
- header/sidebar 引用 B 路并行产出的 `icons/installer-header.bmp` /
  `icons/installer-sidebar.bmp`（同路径文件由 B 路提供）。
- **桌面快捷方式勾选框**：放弃。Tauri 2 NSIS 的桌面图标默认行为已内置
  （不需要自定义 template 就会建桌面快捷方式）；要加「勾选框」需要写
  NSIS 自定义模板（`nsis.template` 覆盖整个 nsi 片段），模板与 Tauri 2
  版本强耦合、升级即碎，当前阶段不硬塞，等模板方案在 CI 里稳定后再加。

## 7. capabilities 最小权限复核

前端新增 invoke 的全是 `generate_handler!` 注册的**自定义命令**
（set_window_title/bind_native_file/set_native_dirty/force_quit）——
Tauri 2 里自定义命令天然允许、不进 capabilities。事件侧只 listen
`app:menu` / `app:close-requested` / `app:open-file`，`core:event:allow-listen`
基线已有。`help:home` 的 opener 调用发生在 Rust 侧（不经 webview IPC），
不需要 `opener:allow-open-url` 等任何前端权限。

结论：capabilities/default.json **零新增权限**，与基线一致。

## 验收

- web 门禁：`pnpm -r build` / `pnpm typecheck` / `pnpm lint` /
  `CI=true pnpm -r test`（core 273 / web 297 + 新增桥接单测）/
  `E2E_PORT=4211 npx playwright test`（90+1 不回退）/
  offline e2e（4）/ verify-precache。
- Rust 本机无 cargo（Linux 缺 webkit2gtk），以 release-windows 分支 run
  为权威；红了按日志修到绿。
