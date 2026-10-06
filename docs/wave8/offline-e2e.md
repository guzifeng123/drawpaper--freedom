# Wave8 · 第二路：PWA 真实离线回归（Offline E2E）

> 分支：`feat/pwa-offline-e2e`（基于 develop `139c46f`）
> 日期：2026-10-06

## 1. 目标与方案

对**生产构建**（VitePWA generateSW / workbox）做真实断网 e2e，补齐 Wave1/Wave5c 只有
静态 precache grep（`scripts/verify-precache.mjs`）而没有运行时证据的缺口。

- 现有 `playwright.config.ts` 的 webServer 是 `pnpm dev`（vite dev）：dev 模式不注册 SW、
  且 `window.__drawpaper__` 测试钩子仅 DEV 挂载，**不能复用于离线断言**。
- 本路新增 `packages/web/playwright.offline.config.ts`：
  - webServer = `pnpm build && pnpm exec vite preview --port 4188 --strictPort`（生产预览），
    端口 4188（环境变量 `OFFLINE_PORT` 可覆盖），与 dev 类 e2e 的 `E2E_PORT=4187` 隔离。
  - `testDir = ./e2e/offline`，独立 testMatch，不碰现有 dev 套件。
  - 生产无 DEV 钩子，所有操作走真实 UI：双击画布建块、行首 `/` 斜杠菜单、拖入图片、
    `Ctrl+P` 导出对话框、双击块进入编辑。

### 通用在线引导（helpers.ts bootOnlineWithSW）

1. `goto('/')` → 等 `.react-flow` 渲染；
2. 等 `navigator.serviceWorker.ready` 且 `reg.active`（SW 激活）；
3. 等 workbox precache cache 条目数 ≥ 70（构建基线 78 条）；
4. reload 一次，等 `navigator.serviceWorker.controller` 非空（页面被 SW 接管）。

随后 `context.setOffline(true)` + reload，进入真实断网路径（导航请求由 workbox
NavigationRoute 回退到 precache 的 `/index.html`）。

## 2. 断网用例清单与结果

命令：`cd packages/web && npx playwright test --config playwright.offline.config.ts`
（首次会先 `pnpm build`；本地已有 preview 在 4188 运行时 `reuseExistingServer` 直接复用。）

| # | 用例 | 文件 | 关键断言 | 结果 |
|---|------|------|----------|------|
| 1 | 断网首屏 + 文档/OPFS 图片恢复 | `e2e/offline/doc-recovery.spec.ts` | 联网建文本块 + 拖入图片（OPFS）→ 断网 reload：外壳渲染、文本可见、`<img>` naturalWidth>0、双击块可继续输入 | ✅ 4.2s |
| 2 | 懒加载 chunk 断网可用 | `e2e/offline/lazy-chunks.spec.ts` | 断网点导出 PNG（html-to-image chunk）、PDF（pdf-lib chunk）真实产出下载；断网首次插公式块（katex chunk+CSS）渲染 `.katex`；首次插代码块产出 `.hljs` | ✅ 9.9s |
| 3 | KaTeX 字体断网可用 | `e2e/offline/katex-fonts.spec.ts` | 断网渲染公式后字体请求（KaTeX_*.woff2）命中 precache、0 failed；`document.fonts.check('16px KaTeX_Main')` 通过；字形 boundingBox 实际绘制 | ✅ 3.1s |
| 4 | 运行时零外网 | `e2e/offline/zero-extranet.spec.ts` | 从首访到断网操作全程审计：所有 http(s) 请求同源 localhost，无外网、无 AI endpoint 调用、断网 0 failed request | ✅ 2.5s |

合计 **4 passed**。

### 关键运行时证据（控制台输出摘录）

```
OFFLINE_PNG_DOWNLOAD 未命名画布_20261006_纵向_p1.png  181640 bytes
OFFLINE_PDF_DOWNLOAD 未命名画布_20261006_纵向.pdf     35785 bytes
KATEX_FONT_REQUESTS 3
  http://localhost:4188/assets/KaTeX_Math-Italic-*.woff2
  http://localhost:4188/assets/KaTeX_Main-Regular-*.woff2
  http://localhost:4188/assets/KaTeX_Size2-Regular-*.woff2
KATEX_FONT_FAILURES 0
OFFLINE_HIGHLIGHT_CHUNK hljs language-js
TOTAL_HTTP_REQUESTS 30 / EXTERNAL_REQUESTS [] / AI_ENDPOINT_CALLS [] / FAILED_REQUESTS []
```

截图（`packages/web/test-results/offline/`）：
- `doc-recovery-offline.png`：断网 reload 后文本块「离线恢复标记-X7-断网追加」可见可编辑，图片块正常渲染。
- `katex-glyph-offline.png`：断网渲染的 Σ 求和/分数公式字形（字体 precache 命中后绘制）。
- `lazy-chunks-offline.png`：断网下公式块 + 代码块 + 导出产物并存的画布。
- `offline-未命名画布_*.png / .pdf`：断网真实下载产物。

## 3. SW 更新生命周期走查结论

核对对象：`vite.config.ts` 的 `VitePWA({ registerType: 'autoUpdate', workbox: { globPatterns, maximumFileSizeToCacheInBytes } })`。

构建产物 `dist/sw.js`（generateSW）实际行为：

- 顶部 `self.skipWaiting()` + `clientsClaim()` —— **新 SW 安装完成立即激活并接管已打开页面**，
  不存在 waiting 态；
- `cleanupOutdatedCaches()` —— 旧版本 precache 缓存自动清理；
- 末尾 `NavigationRoute(createHandlerBoundToURL("index.html"))` —— 离线导航回退到 precache 的 shell；
- `dist/registerSW.js` 仅在 `window.load` 后 `navigator.serviceWorker.register('/sw.js', {scope:'/'})`，
  无自定义 waiting/skipWaiting/controllerchange 提示 UI。

结论：

1. **有新版本时不会卡在 waiting**：autoUpdate 模式下 workbox 直接 emit `skipWaiting()`，
   新版 SW 安装后自动激活，无需用户点「刷新」确认。
2. **reload 流程不卡死**：激活后 `clientsClaim` 接管；用户手动 reload 即加载新 shell。
   当前标签页在 reload 前继续跑旧 chunk（良性，无 reload 死循环）。
3. 未发现需要修复的 SW 缺陷 —— 本路**未改动任何运行时代码**，因此无需为 SW 补单测。
   （若未来切到 `registerType: 'prompt'`，需要补 waiting → skipWaiting → controllerchange 的
   用户提示流程及对应测试。）

## 4. 生产 dist 零外网证据

静态层（已有）：`node scripts/verify-precache.mjs` 断言 dist 全部 js/css/html/字体在 sw.js
precache 清单（81 条构建产物条目）。

运行时证据（本路新增，`zero-extranet.spec.ts` + 各用例的 `attachRequestAudit`）：

- 从页面首次导航（在线）到断网操作全程，Playwright 逐请求审计：30 条 http(s) 请求全部
  `http://localhost:4188` 同源；
- 外网请求：0；AI endpoint（openai/anthropic/chat/completions 等）调用：0（默认未配置，
  确未发起）；
- 断网阶段失败请求：0（同源 js/css/字体/导航全部 precache 命中）。

## 5. headless 无法覆盖项 → 人工验证步骤

以下项 headless e2e 不便稳定覆盖，建议手动复验：

1. **真实弱网/飞行模式**：Chrome DevTools → Network → Offline 后手动刷新，确认 PWA 可离线打开、
   最近文档恢复、再联网后 SW 自动更新到新版本。
2. **安装到桌面（standalone）**：地址栏安装图标 → 独立窗口启动，验证 manifest icons
   （SVG）与 `display:standalone` 行为。
3. **SW 真实升级路径**：改一行业务代码 → `pnpm build` → 浏览器开两个 tab，确认旧 tab 不卡
   waiting、刷新后切到新 shell、旧 precache 缓存被清理。
4. **大容量图片/附件 OPFS 配额**：拖入 MB 级图片断网 reload，确认 OPFS 写盘与配额 toast。

## 6. 门禁

- `pnpm -r build` / `pnpm typecheck` / `pnpm lint`(0 error) / `pnpm -r test`：基线只增不减；
- `E2E_PORT=4187 npx playwright test`（dev 套件，基线 54 passed +1 skipped）不回退；
- `node scripts/verify-precache.mjs` 通过；
- 离线套件独立命令：`npx playwright test --config playwright.offline.config.ts`（4 passed）。
