# Wave1-E：工具栏 / 文档列表 / 搜索 / shadcn 基础组件 / A4 导出与打印管线 / PWA

> 所有者：Wave1-E。分支 `feat/web-panels-export`。
> 范围：`packages/web/src/components/ui/`、`packages/web/src/panels/`、`packages/web/src/export/`、`src/index.css`、`tailwind.config.ts`。
> 共享配置改动（显式列出）：`vite.config.ts`（PWA icons）、`index.html`（meta）、`vitest.config.ts`（`@` 别名 + globals）。

## 1. 组件清单

### 1.1 shadcn 基础组件（`src/components/ui/`）
一次铺齐，风格与既有 `button.tsx` 一致（cva + cn + tailwind CSS 变量）：

| 文件 | 说明 |
|---|---|
| `input.tsx` `textarea.tsx` `label.tsx` | 基础表单控件 |
| `dialog.tsx` | Radix Dialog 组合（Overlay/Content/Header/Footer/Title/Description） |
| `alert-dialog.tsx` | 受控确认框（未装 @radix-ui/react-alert-dialog，用 Dialog 组合，危险主按钮） |
| `dropdown-menu.tsx` `context-menu.tsx` | Radix 菜单 |
| `popover.tsx` `tooltip.tsx` | 浮层/提示 |
| `select.tsx` `tabs.tsx` | Radix 选择/标签页 |
| `switch.tsx` `checkbox.tsx` | 开关/复选 |
| `slider.tsx` `scroll-area.tsx` `separator.tsx` | 滑杆/滚动区/分隔线 |
| `badge.tsx` `toggle.tsx` `toolbar.tsx` | 徽标/按压按钮/工具栏容器（普通 div + cva） |

`index.css` 补齐 shadcn 所需 CSS 变量（popover/success/warning 等）与打印隐藏规则；`tailwind.config.ts` 补 popover/success/warning 色与 fade/zoom/slide keyframes。

### 1.2 面板（`src/panels/`）
| 文件 | 说明 |
|---|---|
| `panels-api.ts` | **PanelsApi 结构型接口**（数据切片 + 回调） |
| `create-mock-panels-api.ts` | 自包含内存 mock（可交互，供开发/测试/截图） |
| `TopToolbar.tsx` | 标题行内重命名、保存状态文案、文档菜单（新建/导入/导出 .kbnote/立即保存）、撤销重做、布局三模式、间距弹层（rank/node slider + 仅整理选中分支 switch）、搜索/导出按钮 |
| `DocsListPanel.tsx` | 左侧可折叠列表、友好时间、当前高亮、行内重命名/复制/删除（ConfirmDialog） |
| `SearchPanel.tsx` | 浮层搜索、`<mark>` 高亮、块类型图标、↑↓/Enter/Esc |
| `lib/toast.tsx` | zustand 自研轻量 toast（success/warn/error，自动消失，`<Toaster/>` 视口） |

### 1.3 导出（`src/export/`）
| 文件 | 说明 |
|---|---|
| `filename.ts` | 纯函数：`buildExportFileName`、`sanitizeFileName`、`formatDateCompact`、`buildPageFileName` |
| `layout-utils.ts` | 纯函数：`sheetSizePx`、`contentSizePx`、`pageNumberLabel`、默认选项 |
| `ExportDialog.tsx` | 导出选项弹窗（方向 radio 卡片 / 边距 / 页眉页脚页码 / 边标签 / 黑白 / 范围 / 三模式 tabs / 分页预览开关 / 文件名实时预览 / 三个操作按钮） |
| `PageBreakOverlay.tsx` | 画布上 A4 虚线矩形 + 页码 + 孤块黄标 + 原点拖拽手柄（纯展示，props 驱动） |
| `render/tiptap-static.tsx` | Tiptap JSON → 静态 HTML（标题/段落/列表/待办/引用/图片/分隔线/行内格式/链接），`.tp-gray` 黑白降级 |
| `PrintSheets.tsx` | 离屏打印容器（portal 到 body）：每页严格 A4 `.sheet`、节点绝对定位、页内 SVG 边（贝塞尔+箭头+标签）、成对续接圆圈、孤块黄角标、页眉页脚页码 |
| `print-pipeline.ts` | `installPageStyle`（动态 `@page`）、`runVectorPrint`（window.print）、`downloadSheetsAsPng`（html-to-image scale≈3）、`downloadSheetsAsPdf`（pdf-lib 合成 A4 pt） |
| `useExportModel.ts` | 胶水 hook：调 core `layoutTree`/`paginate*`（本分支 throw，try/catch 返回空结果），不写单测 |

## 2. PanelsApi 完整签名

见 `src/panels/panels-api.ts`。数据切片：`docs / currentDocId / doc / saveState / savedAt / selectedNodeIds / layoutPrefs / branchOnly / canUndo / canRedo / page / exportOpen / searchOpen / searchQuery / searchResults / activeSearchIndex`。回调：`newDoc/renameDoc/duplicateDoc/removeDoc/openDoc/importKbnote/exportKbnote/requestSave/undo/redo/setLayoutMode/previewLayout/setRankSpacing/setNodeSpacing/setBranchOnly/setPageSettings/setPageOrigin/openExport/closeExport/openSearch/closeSearch/setSearchQuery/selectSearchResult/flyToNode`。

## 3. 导出管线数据流

```
api.doc + api.page（PageSettings）
  → useExportModel.computeResult()
      → core.layoutTree(nodes, edges, measured, mode)      [Wave1-B 实现，本分支 throw]
      → core.paginateFit / paginateTiles / paginateFlow     [Wave1-B 实现，本分支 throw]
      → PaginateResult { pages[], orphans[], totalPages }
  → <PrintSheets result doc settings edgeLabelsVisible/>    portal 到 body
      每页 .sheet（A4 px，按 orientation）
        节点：margin + (node.x - worldRect.x) * page.scale
        边：页内 SVG 贝塞尔 + markerEnd 箭头 + 可选 label
        续接：page.continuations → 同编号 circle
        孤块：result.orphans → 黄色角标
        页眉 doc.title / 页脚「第 n / N 页」
  → 三条输出：
      打印/另存 PDF：installPageStyle(A4 orient) → body.drawpaper-printing → await fonts → window.print() → 清理
      高清 PNG：collectSheetElements() → toPng(sheet,{pixelRatio:3}) 逐页下载（_p1/_p2）
      直接 PDF：toPng 逐页 → PDFDocument.embedPng → addPage(A4_PT) → drawImage → save 下载
```

## 4. 打印 CSS 策略
- `index.css`：`@media print { body.drawpaper-printing #root { display:none } }`；`.drawpaper-print-container` 屏幕隐藏、打印时显示。
- 方向切换由 `print-pipeline.installPageStyle(orientation)` 动态注入 `<style id="drawpaper-print-page">`：`@page { size: A4 portrait|landscape; margin: 0 }`，打印后移除。
- `.sheet` 间 `page-break-after: always`。
- 黑白模式：容器加 `.tp-gray`，边/文字降级灰黑，`<span style=color>` 不再着色。

## 5. PWA 改动清单
- `public/icon-192.svg`、`public/icon-512.svg`（新增，画布+块线条 motif，圆角深蓝底）。
- `vite.config.ts`：manifest.icons 增加 192/512 SVG（`image/svg+xml`，512 带 `maskable`）。
- `index.html`：加 `apple-touch-icon` 与 `description` meta。
- 离线预缓存沿用既有 `generateSW`（globPatterns 已含 js/css/html/svg/png/ico），构建日志确认 precache 11 entries。
- 未生成 192/512 PNG：运行时无 canvas/rsvg 可用，SVG icon 被 Chromium 接受为可安装 PWA 图标；PNG 产物留待后续。

## 6. 测试清单（vitest + jsdom，32 用例全绿）
- `export/filename.test.ts`：中文清洗、非法字符、日期格式、纵横向命名、扩展名归一、多页 _p1/_p2。
- `export/layout-utils.test.ts`：A4 px 常量、三档边距内容区宽高、页码文案。
- `export/PrintSheets.test.tsx`：页数/页码、成对续接圆圈、孤块黄标、折叠子树缺席、`.tp-gray`。
- `export/ExportDialog.test.tsx`：默认值、切横向/模式 tabs/边距/黑白→写回 page、三按钮回调。
- `panels/SearchPanel.test.tsx`：结果渲染+mark 高亮、Enter→flyToNode、Esc 关闭。
- `panels/DocsListPanel.test.tsx`：列表渲染、删除走 ConfirmDialog→removeDoc。
- `panels/lib/toast.test.tsx`：fake timers 自动消失、error 渲染。

## 7. 截图路径（未提交，临时挂载后已还原 App.tsx）
- `/tmp/wp-shots/01-overlay-dialog-search-docs.png`：工具栏+文档列表+搜索高亮+导出弹窗+分页虚线+孤块黄标。
- `/tmp/wp-shots/02-export-dialog.png`：导出弹窗特写。
- `/tmp/wp-shots/03-print-sheets.png`：打印容器两页（含续接圆圈 A、页眉页脚页码）。
- `/tmp/wp-shots/04-docs-list.png`：文档列表。
- `/tmp/wp-shots/05-search-panel.png`：搜索面板。

## 8. 共享配置改动（越界但必要，显式列出）
- `vitest.config.ts`：补 `resolve.alias['@']`（镜像 vite.config）与 `globals: true`（testing-library 自动 cleanup）。不改则组件测试无法解析 `@/` 且测试间互相污染。
- `vite.config.ts` / `index.html`：PWA（见 §5）。

## 9. 遗留问题 / 接缝
- core `layoutTree`/`paginate*` 本分支 throw；`useExportModel` try/catch 返回空分页，真实分页与 30 块验收样例由 Wave1-B 实现后、Wave2 e2e 联调。
- 导出范围「仅选中分支」当前为本地 UI 状态，scopeNodeIds 传参待 Wave2 接 selection。
- 分页原点拖拽在 overlay 内完成，`setPageOrigin` 已接；画布消费待 Wave1-D。
- 未生成 PNG 位图图标（SVG 已满足 PWA installable）。
- 未新增依赖；`typecheck / test / build` 全绿。
