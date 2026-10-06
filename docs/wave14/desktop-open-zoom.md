# Wave14 · C 路：桌面端「打开缩放」两缺陷修复

> 分支 `fix/desktop-open-zoom`，基线 `origin/develop = 575c1e9`（rc.6）。
> 本路只改 `apps/desktop-tauri/src-tauri/**`、`packages/web/src/host/**`、
> `packages/web/src/editor` 内为菜单接线所必需的最小转发（`state/view-bus.ts`、
> `canvas/CanvasEditor.tsx` 注册段、`state/useKeyboardShortcuts.ts` 两个键位）、
> `.github/workflows/release-windows.yml` 白名单一行、本目录与 `CHANGELOG.md`。
>
> 红线：版本号零 diff（`tauri.conf.json` / `Cargo.toml` / `package.json` 未动），
> 无 tag，workflow 仅在 `on.push.branches` 追加 `fix/desktop-open-zoom` 一项。

## 缺陷 #2：双击唤起已运行实例要真正打开文档

### 现场

`lib.rs` 单实例回调（`tauri_plugin_single_instance::init` 闭包）原先只 emit：

```json
{ "path": "<argv[1]>", "external": true }
```

没有 `text`。而前端 `desktop-bridge.routeOpenFile` 对缺 `text` 的载荷按「webview
无任意路径读权限」直接降级忽略——于是第二实例转发只让窗口聚焦，文档不切换。

「打开最近」子菜单走的是另一条路：Rust 自己读盘后 emit **富载荷**
`{path,name,text,external:true}`，前端才能 `parseKBNote → loadDoc → bindNativeFile`。

### 方案：抽取共享读盘 helper `open_external_path`

把「打开最近」里的读盘 + emit 逻辑抽成 `fn open_external_path(app, p: &Path)`，
三条入口共用：

| 入口 | 触发 | 原先 | 现在 |
| --- | --- | --- | --- |
| `recent:<n>` 菜单点击 | 用户点 File→打开最近 | 已富载荷 | 委托同一 helper |
| 冷启动 `maybe_seed_startup_file` | 首次双击 `.kbnote`（无实例） | 仅 emit `{path}` | 委托同一 helper |
| 单实例回调 | 应用已运行时再双击 `.kbnote` | 仅 emit `{path,external}`（**坏**） | 委托同一 helper |

helper 行为：

1. 校验扩展名是 `.kbnote`，否则静默返回（单实例转发可能不带文件参数）。
2. 读盘成功 → 绑定 `current_path`、`push_recent`、emit 富载荷。
3. 读盘失败 → 从 recents 剔除该路径、重建菜单，再 emit 一个**轻量错误事件**
   `app:open-file-error`（不 panic、不 reject）。

### Rust 富载荷 JSON 形状

成功（`app:open-file`）：

```json
{
  "path": "C:/Users/x/Documents/笔记.kbnote",
  "name": "笔记.kbnote",
  "text": "<.kbnote 文件全文>",
  "external": true
}
```

失败（`app:open-file-error`）：

```json
{ "path": "C:/.../gone.kbnote", "message": "无法打开文件：os error 2 (file not found)" }
```

前端 `onOpenFileErrorEvent` 订阅后 `pushToast('error', message)`。

### 前端确认

`routeOpenFile` 富载荷路径（`parseKBNote(payload.text) → loadDoc → bindNativeFile`）
对 `app:open-file` 生效；缺 `text` 的异常载荷仍按旧降级忽略。冷启动 setup 阶段 emit
可能早于 webview 挂载监听（既有竞态，冒烟不覆盖）；热启动时监听已就绪，必达。

## 缺陷 #3：视图菜单缩放接线

### 现场

`lib.rs` 建了 `view:fit`（「适应屏幕\tCtrl+0」）、`view:zoom-in`（「放大\tCtrl+=」）、
`view:zoom-out`（「缩小\tCtrl+-」）菜单项并 emit，但 `desktop-bridge.routeMenu` 在
`:117` 注释「view:fit / view:zoom-* 由 Rust 自取，前端不绑定」——Rust 根本操作不了
画布，三个是死项。

### 方案：最小事件总线 `editor/state/view-bus.ts`

`desktop-bridge` 是非 React 模块，拿不到 `useReactFlow()` 的 `rf` 句柄。新建一个极薄
总线：

```ts
registerViewActionHandler(h) // CanvasInner 挂载时注册真实 rf 动作，卸载注销
requestViewAction(action)    // routeMenu 调用；无注册者时静默 no-op
```

`CanvasInner` 注册段（复用工具栏按钮 / 快捷键同一个 `rf`，不新写缩放算法）：

```ts
registerViewActionHandler((a) => {
  if (a === 'fit') rf.fitView({ duration: 200 });
  else if (a === 'zoom-in') void rf.zoomIn();
  else void rf.zoomOut();
});
```

### view 菜单 id → action 映射表与加速键

| 菜单 id | 菜单标签 | 转发 action | 前端实际快捷键 |
| --- | --- | --- | --- |
| `view:fit` | 适应屏幕 `Ctrl+0` | `rf.fitView({duration:200})` | Ctrl+0（既有） |
| `view:zoom-in` | 放大 `Ctrl+=` | `rf.zoomIn()` | Ctrl+=（本次补齐） |
| `view:zoom-out` | 缩小 `Ctrl+-` | `rf.zoomOut()` | Ctrl+-（本次补齐） |

菜单标签是**展示文本**（`item` helper 传 `None` accelerator），真实键位在
`useKeyboardShortcuts` 的 `mod` 分支。本次补齐了 `case '='` / `case '-'`，与标签一致，
故 Rust 菜单标签无需改动。浏览器环境 `routeMenu` 只在 Tauri 运行时触发，总线无注册者
时 no-op，绝不报错。

## 测试

- `host/desktop-bridge.test.ts`：三个 view 菜单 id → 总线 action 断言；富 `app:open-file`
  载荷走到 `bind_native_file`；`app:open-file-error` → toast。
- Rust 无本地 cargo，以 `release-windows` 真实构建 + x64 7 条冒烟保持全绿为准。
