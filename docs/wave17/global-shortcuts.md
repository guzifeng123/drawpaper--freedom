# Wave 17 — Desktop global shortcuts

> 范围：仅 Windows 桌面壳（`apps/desktop-tauri/src-tauri`）。纯 Rust 侧，不进 web chunk，不加 npm 依赖。
> 基线：`3451c37`（rc.8）。分支：`feat/desktop-global-shortcuts`。

## 1. 目标

让一组常用快捷键在**窗口失焦时也能触发**（系统级 / global hotkey），而不是只能在 drawpaper
前台时由菜单加速键响应。动作与现有原生菜单**单一来源**：快捷键回调不新写业务逻辑，而是复用
菜单通道。

## 2. 默认快捷键集

| 快捷键 (accelerator) | action | 触发的菜单 id / 动作 | 对应菜单 |
|---|---|---|---|
| `Ctrl+Shift+D` | `focus_window` | show + unminimize + set_focus 主窗口 | （无菜单，窗口 API） |
| `Ctrl+S` | `file:save` | emit `app:menu {id:"file:save"}` | 文件 → 保存 |
| `Ctrl+P` | `export:print` | emit `app:menu {id:"export:print"}` | 导出 → 打印 / 另存为 PDF |
| `Ctrl+F` | `view:search` | emit `app:menu {id:"view:search"}` | 视图 → 搜索… |

菜单 id 以 `build_menu`（`src/lib.rs`）里 `MenuItem::with_id(handle, "<id>", ...)` 的实际
字符串为准。`file:save-as` 已经在菜单里用真实 accelerator `CmdOrCtrl+Shift+S` 绑定（菜单
加速键，仅前台生效），**不**再注册为全局快捷键，避免双重触发。

## 3. 动作单一来源

- 菜单 id 类动作：快捷键回调里 `app.emit("app:menu", json!({"id": <menu_id>}))`，与
  `on_menu_event` 末尾那行（`src/lib.rs`）发出的载荷**完全一致**。前端
  `desktop-bridge.ts routeMenu` 无需任何改动即可处理。
- `focus_window`：唯一的特殊动作，直接走窗口 API（`get_webview_window("main")` →
  `show()` + `unminimize()` + `set_focus()`）。
- 没有任何快捷键回调直接调用 store action / 对话框 / 文件 IO。

## 4. 配置文件（用户可改）

- 位置：app 配置目录下 `drawpaper-shortcuts.json`（与 `drawpaper-recents.json`、
  `drawpaper-autosave.json` 同目录；Windows 上即 `%APPDATA%\com.drawpaper.app\`）。
- 格式：扁平 JSON 对象，key 是 accelerator 字符串，value 是 action 字符串。

```json
{
  "Ctrl+Shift+D": "focus_window",
  "Ctrl+S": "file:save",
  "Ctrl+P": "export:print",
  "Ctrl+F": "view:search",
  "Ctrl+Shift+G": "export:print"
}
```

- 合法 action 集合（见 `shortcuts::known_actions()`）：
  `focus_window`、`file:save`、`export:print`、`view:search`。
- value 写成空字符串 `""` = 解绑该 accelerator（例如 `"Ctrl+F": ""` 关掉全局搜索热键）。
- 不提供该文件 = 用默认集（静默，不告警）。

## 5. 失败 / 冲突行为（绝不 panic、绝不阻断启动）

| 情况 | 行为 |
|---|---|
| 配置文件不存在 | 静默用默认集 |
| 配置文件读不出 / 不是合法 JSON / 不是对象 | `log::warn!` 记录原因，整份文件忽略，回退默认集 |
| 某个 accelerator 非法（空 / 含空白 / 以 `+` 结尾） | `log::warn!` 跳过该项，其余继续 |
| 某个 action 不在已知集合里 | `log::warn!` 跳过该项 |
| 同一 accelerator 在用户文件里出现两次且指向不同 action | `log::warn!` 保留先出现的，丢弃后出现的 |
| `register` 返回 Err（被别的应用占用 / OS 拒绝） | `log::warn!` 跳过该项，其余继续 |

启动结束时打一条锚点日志：`global-shortcuts: registered N of M bindings`，
以及逐项 `global-shortcut registered: <accel> -> <action>`。CI 冒烟就 grep 这条锚点。

## 6. 生命周期

- 在 `setup()` 里、菜单建好之后注册（`setup_global_shortcuts(app.handle())`）。
- 退出时依赖插件自身的 Drop（以及 Windows 进程退出时 OS 自动释放 `RegisterHotKey`）。
  **刻意不在 `RunEvent::ExitRequested` 里调 `unregister_all()`**：插件内部把注销派发回主线程
  并阻塞等待，而 `ExitRequested` 回调本身就在主线程上跑，会自死锁。

## 7. 与菜单加速键的关系

- 菜单里的 `Ctrl+S` / `Ctrl+P` / `Ctrl+F` 目前只是**标签文本**（`保存\tCtrl+S`），
  并未用 `MenuItem::with_id` 的 accelerator 字段真正注册（除 `file:save-as` 外）。
  也就是说窗口前台时这些组合键靠菜单/系统菜单消息循环响应，窗口失焦时不响应。
- 本功能补上了**失焦可用**这一半；前台时菜单通道照常工作，全局快捷键 emit 同一个
  `app:menu` 事件，前端幂等处理，不会出现「保存两次」。

## 8. 纯函数与测试

`src/shortcuts.rs` 不 import 任何 Tauri / serde，可独立编译跑测试：

```
rustc --test src/shortcuts.rs -o /tmp/shortcuts_test && /tmp/shortcuts_test
```

覆盖：默认集顺序、配置缺失静默、JSON 损坏回退、用户覆盖、未知 action 跳过、
非法 accelerator 跳过、空 action 解绑、同 accelerator 冲突保留先者、同 action 重复无害、
action→menu id 映射、额外用户绑定追加在默认之后。

## 9. CI 冒烟

`release-windows.yml` 新增唯一名 `Smoke (x64): global shortcuts register without crashing`：
启动安装后的 exe → 轮询进程存活且 `drawpaper.log` 出现 `global-shortcuts: registered` 锚点
→ 杀进程。**不**模拟失焦真实触发（那是人工项）。
