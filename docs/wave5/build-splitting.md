# Wave5c — 构建代码分包 / 消除主 chunk 超限

## 目标

消除 `packages/web/dist/assets/index-*.js` 单包 ~2107KB 的 >500KB 警告，用
**manualChunks 供应商分包 + 功能级动态 import** 把重型依赖移出首屏，同时保证 PWA
离线（generateSW precache）不破坏。

基线 develop = `006cf2d`，分支 `chore/build-code-splitting`。

---

## 1. 分包前后 chunk 体积对比

构建产物（`dist/assets/`），体积为 minify 后 KB（gzip 在括号）：

| chunk | 前 | 后 | 首屏? | 加载时机 |
|---|---|---|---|---|
| `index-*.js`（业务主包） | **2107.27 KB** (707.64) | **458.6 KB** (145.4) | ✅ 首屏 | 入口 |
| `index-*.css` | 82.67 KB (18.1) | 35.7 KB (7.4) | ✅ 首屏 | 入口（其余 CSS 拆到各 chunk） |
| `react-vendor-*.js`（react/react-dom/scheduler） | 在主包 | 139.0 KB (45.6) | ✅ 首屏 | 入口 preload |
| `xyflow-*.js` + `.css` | 在主包 | 183.4 KB (60.9) + 15.5 KB | ✅ 首屏 | 入口 preload（画布必需） |
| `tiptap-*.js`（@tiptap + prosemirror） | 在主包 | 390.0 KB (128.4) | ✅ 首屏 | 入口 preload（块编辑器/静态渲染） |
| `dexie-*.js`（IndexedDB 持久层） | 在主包 | 94.1 KB (32.4) | ✅ 首屏 | 入口 preload（启动即加载文档） |
| `minisearch-*.js`（全文搜索索引） | 在主包 | 17.6 KB (5.9) | ✅ 首屏 | 入口 preload |
| `katex-*.js` + `katex-*.css` + 59 字体 | 在主包（CSS 进 index.css） | 255.9 KB (77.9) + 29.5 KB + ~1MB 字体 | ❌ 懒加载 | 首个公式块渲染时 `await import('katex')` + CSS |
| `highlight-*.js` + `highlight-data-*.js`（hljs + 11 语言 + lowlight） | 在主包 | 87.6 KB (29.8) + 0.9 KB | ❌ 懒加载 | 首次双击编辑块时 `await ensureHighlighter()` |
| `pdf-lib-*.js` | 在主包 | 428.0 KB (181.2) | ❌ 懒加载 | 导出弹窗点「直接下载 PDF」时 `await import('pdf-lib')` |
| `html-to-image-*.js` | 在主包 | 13.4 KB (5.4) | ❌ 懒加载 | 导出弹窗点「PNG / 直接下载 PDF」时 `await import('html-to-image')` |

**首屏传输量**：gzip 后约 `145(index) + 45.6(react) + 60.9(xyflow) + 128.4(tiptap) + 32.4(dexie) + 5.9(minisearch) + 7.4+2.7+8(CSS)` ≈ **~436 KB gzip**（之前全部 707 KB gzip 压在一个 index 包里）。
主包 raw 从 2107KB → 459KB，**Vite >500KB 警告消除**（chunkSizeWarningLimit=600，最大单 chunk 459KB < 阈值）。

---

## 2. manualChunks 策略（`vite.config.ts`）

函数式 `build.rollupOptions.output.manualChunks(id)`，按 node_modules 路径正则分桶（顺序敏感，先具体后兜底）：

- `react-vendor`：react / react-dom / scheduler / react-is
- `xyflow`：@xyflow/*
- `tiptap`：@tiptap/* 与 prosemirror-*
- `katex`：katex（懒 chunk）
- `highlight`：highlight.js / lowlight（懒 chunk）
- `pdf-lib`：pdf-lib / @pdf-lib / pako / zlibjs / rgb2hex（懒 chunk）
- `html-to-image`：html-to-image（懒 chunk）
- `dexie`、`minisearch`、`drawpaper-core`：各自独立 chunk

业务代码（`src/`）不强制分桶，留在 `index-*.js`。

---

## 3. 动态 import 时机与 loading/失败处理

| 依赖 | 触发时机 | 实现位置 | loading / 失败 |
|---|---|---|---|
| `pdf-lib` + `html-to-image` | 导出弹窗点「直接下载 PDF」 | `export/print-pipeline.ts` `downloadSheetsAsPdf` 内 `await Promise.all([import('pdf-lib'), import('html-to-image')])` | `useExportModel` 包 `setBusy('pdf')`，按钮文案「加载导出库…」+ disabled；catch → `pushToast('error', 'PDF 合成失败…')` |
| `html-to-image` | 点「导出高清 PNG」 | `downloadSheetsAsPng` 内 `await import('html-to-image')` | 同上，`busy='png'` |
| KaTeX（JS + CSS + 字体） | 首个公式块静态渲染 | `editor/tiptap/katex-html.ts` `ensureKatex()` 动态 `import('katex')` + `import('katex/dist/katex.min.css')`，缓存 promise | `p1-blocks.tsx` `EquationHtml` 组件：加载中文案「公式渲染中…」，`renderEquationAsync` resolve 后替换 `dangerouslySetInnerHTML` |
| highlight.js / lowlight | 首次双击编辑任意块 | `editor/tiptap/highlight.ts` `ensureHighlighter()` 动态 `import('./highlight-data')`；`createBlockEditor` 改为 `async`，`await ensureHighlighter()` 后把真实 lowlight 传给 `CodeBlockLowlight.configure` | `BlockShell` 的编辑 effect 改 async，加载完再 `setEditor`；取消时 `destroy()` 防泄漏。代码块静态高亮 `CodeHtml` 加载中显示「代码高亮加载中…」 |

矢量打印主线（`window.print()` / `runVectorPrint`）**不依赖** pdf-lib / html-to-image，保持立即可用。

### 关键技术决策

- **lowlight 同步依赖张力**：`CodeBlockLowlight` 扩展在 `addProseMirrorPlugins` 时校验真实 lowlight 实例（传 dummy 会抛 "You should provide an instance of lowlight"）。因此 `createBlockEditor` 改为 async，在创建编辑器前 `await ensureHighlighter()`。lowlight chunk（~88KB）在**首次双击编辑块**时加载（用户手势触发，非首屏），之后全程缓存复用。
- **静态渲染路径**：`getStaticExtensions()`（`tiptapJsonToHtml` 用）不跑 ProseMirror 插件，lowlight 传空壳即可，不触发 hljs 加载。
- **AI 面板**：`src/ai/` 仅含 React 组件 + fetch（无重型 SDK），且已在 App 条件挂载（`{aiPanelOpen ? ...}`），静态 import 体积可忽略，**不做 React.lazy**（收益过小）。

---

## 4. PWA 离线策略

- `vite-plugin-pwa` generateSW，`globPatterns` 从 `js,css,html,svg,png,ico` **追加 `ttf,woff,woff2`**——否则 KaTeX 字体离线不可用。
- `maximumFileSizeToCacheInBytes: 4MB`（已有），单文件最大 ~63KB 字体，远低于上限。
- 构建后 precache 从 **11 entries / 2151 KiB** 增至 **82 entries / 3200 KiB**（含全部懒 chunk 与 59 个 KaTeX 字体文件）。

### precache 完整性核查

新增脚本 `packages/web/scripts/verify-precache.mjs`：解析 `dist/sw.js` 的 workbox 预缓存清单，断言 dist 下所有 js/css/woff2/woff/ttf/html 资源都在清单中，并显式校验 pdf-lib / html-to-image / katex / highlight / index / tiptap / xyflow / react-vendor 关键 chunk 存在。

运行结果：
```
precache 清单：79 条
dist 待缓存资源：75 个（js/css/字体/html）
✓ 全部构建产物（含懒加载 chunk + KaTeX 字体）均在 precache 清单中
```

### 人工离线验证步骤（脚本外的运行时确认）

e2e 当前跑 dev server（依赖 `window.__drawpaper__` 钩子，生产构建不挂载），未新增离线 e2e。离线运行时验证由脚本化 precache 完整性 + 人工步骤保证：

1. `pnpm build && pnpm preview`（生产构建）。
2. Chrome DevTools → Application → Service Workers → 确认 sw 已激活；Network → 勾 Offline → reload，主界面可用。
3. 离线状态下：插入一个公式块（断言 katex chunk 从 Cache Storage 命中、字体正常显示）；插入代码块（hljs chunk 命中）；打开导出弹窗点「导出 PNG」与「直接下载 PDF」（pdf-lib / html-to-image chunk 命中、产物正常下载）。
4. 若上述任一路径在离线下走网络失败，说明 precache 漏了对应资源——重跑 `node scripts/verify-precache.mjs` 定位。

---

## 5. 测试 / 回归

- web 单测：**176/176 通过**（`table-ops.test.tsx` 三例改 async/await；`static-p1.test.tsx` 新增 `await ensureKatex() / ensureHighlighter()`）。
- core 单测：未触碰 core，**129 不回归**。
- e2e：**30/30 通过**（dev server，动态 import 由 Vite 原生支持；`acceptance-export` 真实 PNG/PDF 导出、矢量 PDF、性能 500/2000 块 TTI 6.48s、拖拽/滚轮 60fps 均绿）。
- `tsc --noEmit` 0 error；`vite build` 无 chunk 大小警告。

---

## 6. 风险与遗留

- **导出首次点击多一次 chunk 加载**：用户首次点「导出高清 PNG」或「直接下载 PDF」时需先下载 html-to-image(13KB) + pdf-lib(428KB gzip 181KB)，有可感知的首次延迟（按钮显示「加载导出库…」）；第二次起走缓存。矢量「打印 / 另存 PDF」路径不受影响，立即可用。
- **首次双击编辑块加载 hljs（88KB）**：比旧版（主包内含）多一次小 chunk 请求，但首屏因此瘦了 88KB。
- **KaTeX 字体总量 ~1MB** 全量 precache（82 entries / 3.2MB），PWA 安装体积上升但可离线渲染任意公式。
- 未新增任何依赖；未改 core / store / panels 业务逻辑。
- 离线 e2e 未自动化（dev-server 架构下难稳定），以 `verify-precache.mjs` 脚本 + 上述人工步骤兜底。
