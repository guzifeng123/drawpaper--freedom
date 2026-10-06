# Wave13 阶段 B · 桌面端原生导出接线 + 首跑欢迎文档（web 侧）

> 分支 `feat/web-desktop-export-welcome`，基线 develop `08f0f4a`（rc.5 已发布）。
> 本路只改 `packages/web/` 与本目录。Rust 契约以 A 路冻结的
> `docs/wave13/native-gaps.md`（tip `85b3bd7`）为准。

## 1. `save_export` 四类导出接线

**调用方式**：`TauriHostAdapter.saveExport({ suggestedName, ext, bytes })`
（`packages/web/src/host/tauri-host.ts`）。
- 内部 `blobToBase64(blob)`（`host/blob-base64.ts`，FileReader + 32KB 分块 btoa，纯函数可单测）
  把 Blob 编成标准 base64，再 `invoke('save_export', { suggestedName, ext, bytesBase64 })`。
- 返回联合类型 `{status:'saved',path}` | `{status:'cancelled'}`；`cancelled` 是正常 resolve。
- 写盘失败 / 解码失败走 `reject(string)`，由调用方 toast。

**文件名复用证据（suggestedName 与网页下载逐字一致）**：导出动作仍在
`useExportModel` 里用同一个 `buildExportFileName({title,date,orientation,ext})` 算出
`name`（形如 `{标题}_{YYYYMMDD}_{纵向|横向}.pdf`），再传给「渲染成 Blob」与
「交付 sink」两段：
- PDF：`renderSheetsAsPdf(sheets, name, orientation)` 返回 `{blob, fileName: name}`。
- PNG 多页：`renderSheetsAsPng` 逐页用 `buildPageFileName(name, i)` 命名（`{stem}_p{i+1}.png`）。
- SVG 多页：`renderSvgPages` 用同一 `{stem}_p{i+1}.svg` 命名。
- MD：单文件 `name`。
交付 sink `export/deliver.ts`：
- 浏览器宿主（`getTauriExportHost()` 为 null）→ 维持原 `<a download>` Blob 下载链路，零改动。
- 桌面宿主 → `host.saveExport({suggestedName: fileName, ext, bytes: blob})`；
  `cancelled` 静默 return，`reject` 时 `pushToast('error','导出保存失败：…')`。
即桌面端 `suggestedName` 与浏览器下载文件名是同一个字符串变量，天然逐字一致。

打印（`export:print` / Ctrl+P）仍走前端打印 CSS + `window.print()`，不经 `save_export`。

## 2. 首跑欢迎文档

`packages/web/src/wiring/welcome-doc.ts`：
- 触发条件纯函数 `shouldCreateWelcomeDoc({isTauri, flagSet})` —— 必须同时
  「检测到 Tauri 宿主（`__TAURI__` in window）」且「localStorage 无
  `drawpaper:welcome-doc-v1`」才创建。浏览器/PWA/e2e 无宿主 → 永不创建（有断言）。
- `editor-store.ts` 的 `bootstrap()`：listDocs 后，命中条件则 `loadDoc(buildWelcomeDoc())`
  并 `writeWelcomeFlag()`；否则维持原「打开最近一份 / 新建空白」。
- 文档 `buildWelcomeDoc()`：标题「欢迎使用 drawpaper」，确定性 id `doc_welcome_v1`，
  根块「快速上手」+ 六条 bullet，内容覆盖：
  1. 数据保存位置（浏览器 IndexedDB/OPFS；桌面端原生 `.kbnote`、`%APPDATA%\com.drawpaper.app`、`logs\drawpaper.log`）
  2. 双击 `.kbnote` 直接打开
  3. 常用快捷键（双击建块 / Tab 子块 / Alt+方向导航 / Ctrl+F / Ctrl+Shift+S 另存为 / Ctrl+P 打印）
  4. 同步文件夹 / WebDAV / E2EE 在「设置 → 同步」
  5. SmartScreen 未签名「仍要运行」说明
  6. 帮助菜单检查更新
- 走普通 `loadDoc` → 自动落 IndexedDB，可自由删除；因 e2e 跑在浏览器宿主根本不创建，
  不影响任何文档计数 / 空状态 / e2e 断言。

## 3. 菜单 / 事件接线 diff（`host/desktop-bridge.ts`）

- **富 `app:open-file` 接线**：`onOpenFileEvent` 回调签名由 `(path:string)` 改为
  `(payload: OpenFilePayload)`。新增 `routeOpenFile(payload)`：当 `payload.text` 为字符串时
  走与 `file:open` 成功分支完全相同的 `parseKBNote(text) → loadDoc → bindNativeFile(path)`；
  text 缺失（双击/单实例兼容路径）按既有降级忽略，文件缺失由 Rust 侧剔除、前端不 toast。
  `initDesktopBridge` 新增 `unlistenOpenFile` 订阅与清理。
- **死分支删除**：routeMenu 不再有 `file:open-recent` / `file:clear-recent` 处理；
  `recent:*` 动态子菜单、`help:check-update` / `help:open-data-dir` 均 Rust 自取，前端不绑定
  （default 注释已更新）。
- **save-as 快捷键**：`file:save-as` 菜单事件仍按现有路径走 `saveKbnoteAs` 保存逻辑；
  Ctrl+Shift+S accelerator 由 Rust 原生处理，前端**不重复绑快捷键**。

## 4. 测试

**新增单测（web，+18，302 → 320）**：
- `host/blob-base64.test.ts`：文本往返、空 Blob、跨 32KB 分块大 Blob。
- `host/tauri-host.export.test.ts`：mock invoke，四类 ext 透传、suggestedName 逐字、
  bytesBase64 非空且 atob 解回原文、cancelled 正常 resolve、reject(string) 抛出。
- `export/deliver.test.ts`：浏览器走 Blob URL 下载不调 save_export；桌面 cancelled 静默、
  reject 弹 toast。
- `wiring/welcome-doc.test.ts`：三组合条件、宿主检测、文档六项内容齐全。

**新增 e2e（web，+2，90+1 → 92 passed / 1 skipped）**：
`e2e/wave13-welcome.spec.ts`：① 浏览器环境不检测宿主、不创建欢迎文档、无标记；
② dev-hooks 注入 `__TAURI__` 桩 + 清标记后走真实首跑流程创建「欢迎使用 drawpaper」，
再跑一次因有标记不再创建。

**core 单测**：273（不变）。**离线**：4（不回退）。

## 5. 门禁结果

| 门禁 | 结果 |
| --- | --- |
| `pnpm -r build` | ✅ |
| `pnpm typecheck` | ✅ |
| `pnpm lint`（0 error） | ✅ |
| `CI=true pnpm -r test` | ✅ core 273 / web 320 |
| `E2E_PORT=4215 npx playwright test` | ✅ 92 passed / 1 skipped |
| `OFFLINE_PORT=4216 CI=1 npx playwright test --config playwright.offline.config.ts` | ✅ 4 passed |
| `node scripts/verify-precache.mjs` | ✅ |

零外网：本波无新网络行为（检查更新是 Rust opener 外链，与 web 无关）。
