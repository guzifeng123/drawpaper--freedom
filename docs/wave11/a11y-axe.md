# Wave11 阶段 C：axe-core 自动化无障碍扫描固化与补缺 e2e

基线 develop `9dab2b6`（含 Wave9 a11y 基础、Wave10 同步面板、Wave11 阶段 A 加密区）。
本阶段把「人工复测」项里可自动化的部分固化进 Playwright e2e，并用 axe-core 对六个目标
做 WCAG 2.0/2.1 A+A 扫描，critical/serious 即修源码，moderate 全部入档。

## 1. 依赖（仅 dev，不进产物）

`packages/web/package.json` devDependencies 新增：

```diff
+    "@axe-core/playwright": "^4.10.0",
     "@playwright/test": "^1.48.2",
     ...
     "autoprefixer": "^10.4.20",
+    "axe-core": "~4.10.0",
     "jsdom": "^25.0.1",
```

`@axe-core/playwright` 是 axe-core 的 Playwright 适配子路径包，`axe-core` 为其规则引擎。
两者均仅出现在 `devDependencies`，不进运行时产物（vite 生产构建不引用）。

## 2. 扫描矩阵与结果

扫描器：`new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa'])`，
用例 `packages/web/e2e/a11y-axe.spec.ts`（8 例）。面板控件一律用 role / 可访问名 /
`data-testid` 定位，不依赖临时 class 或 DOM 层级。

| 目标 | 定位方式 | 修复前 critical/serious | 修复后 critical/serious | 修复后 moderate |
| --- | --- | --- | --- | --- |
| 主画布·空文档 | `goto('/')` + `newDoc` | 0 / 0 | **0 / 0** | 0 |
| 主画布·有内容 | `loadStandard`（30 块夹具） | button-name×3（待办勾选框）+ color-contrast×1 | **0 / 0** | 0 |
| 主画布·深色模式 | `.dark` class + 焦点环对比度断言 | button-name×3 + color-contrast×1 | **0 / 0** | 0 |
| 导出对话框 | `Ctrl+P` / role=heading「导出 / 打印」 | aria-valid-attr-value×1（Tabs aria-controls 悬空）+ button-name×6（Switch 无标签） | **0 / 0** | 0 |
| 同步设置面板 | `[data-testid=open-sync]` | button-name×3 + color-contrast×1 | **0 / 0** | 0 |
| AI diff 面板 | route mock OpenAI 端点 → 真实 run→setDiff | button-name×2（Radix Checkbox 无标签）+ color-contrast×1 | **0 / 0** | 0 |
| 大纲面板 | role=button「大纲面板」 | button-name（待办勾选框）+ color-contrast×1 | **0 / 0** | 0 |
| 文档列表面板 | 常驻左侧 aside | button-name（待办勾选框）+ color-contrast×1 | **0 / 0** | 0 |

> 说明：修复前的 button-name / color-contrast 在多个目标里是**同一根因**的复现
> （待办块勾选框、`.block` 更新时间戳、Radix Switch/Checkbox 无 accessible name），
> 故按根因修一次后全部目标归零。

## 3. 修复项（critical / serious，发现即修源码）

1. **待办块勾选框无 accessible name（button-name, critical）**
   `packages/web/src/editor/nodes/blocks.tsx`：todo 勾选 `<button>` 补
   `type="button" role="checkbox" aria-checked aria-label="标记为完成/未完成"`。

2. **AI diff 勾选框无 accessible name（button-name, critical）**
   `packages/web/src/ai/AiDiffDialog.tsx`：Radix `<Checkbox>` 补
   `aria-label={选择建议 ${i+1}：${meta.label}}`。

3. **导出对话框 Switch 无 accessible name（button-name, serious×6）**
   `packages/web/src/export/ExportDialog.tsx`：页眉/页脚/页码/边标签/彩色黑白/分页预览
   六个 `<Switch>` 各补对应 `aria-label`。

4. **导出对话框 Tabs aria-controls 悬空（aria-valid-attr-value, critical）**
   Radix `<Tabs>` 只用作三段式切换器、没有渲染 `<TabsContent>`，触发按钮的
   `aria-controls` 指向不存在的 panel id。改为语义正确的 `role="radiogroup"` +
   三个 `role="radio"` 按钮（视觉不变），移除对 Tabs 组件的引用。

5. **文档列表更新时间戳对比度不足（color-contrast, serious）**
   根因：浅色 `--muted-foreground: 215.4 16.3% 46.9%`（≈#64748b）在
   `--accent`/`--muted` 底（≈#f1f5f9）上仅 4.34:1（< 4.5:1）。
   `packages/web/src/index.css` 浅色 `--muted-foreground` 调到 `215 16% 38%`，
   对比度提升到约 5.7:1。深色 `--muted-foreground` 本就是浅字深底高对比，不动。

6. **viewport 禁止缩放（meta-viewport, moderate）**
   `packages/web/index.html`：去掉 `maximum-scale=1.0, user-scalable=no`，
   改为 `width=device-width, initial-scale=1.0`，允许用户缩放（WCAG 1.4.4）。

## 4. 深色模式 :focus-visible 焦点环对比度（rc.3 遗留）

Wave9 `a11y-keyboard.md` 第 8 节遗留人工复测项：「深色下 `--ring` 是否够亮」。

深色 `--ring: 210 40% 90%`（≈rgb(219,230,240)）落在深色画布底
`--canvas-bg: 222 47% 6%`（≈rgb(8,12,22)）上。深色画布 e2e 内联计算实测：

```
FOCUS_RING_CONTRAST {"outline":"rgb(219, 230, 240)","bg":"rgb(8, 12, 22)","ratio":15.44}
```

WCAG 2.1 SC 1.4.11（非文本对比度，UI 控件/焦点指示）阈值 3:1。实测 **15.44:1**，
达标。现有 `--ring` 值无需改色；e2e 在深色画布用例里读取聚焦块外壳的
`outline-color` 与 `.react-flow` 背景色、按 WCAG 相对亮度公式实时算对比度并断言
`≥3`，把这条人工遗留项固化成自动化回归，防止后续改主题变量时回退。

## 5. moderate 已知清单

本轮扫描在修复后 **0 条 moderate 遗留**（meta-viewport moderate 已在第 3.6 项修复）。
未来若 axe 新增/放开规则引入 moderate，须在本节追加「条目 + 原因 + 建议」。

## 6. 补缺 e2e 证据

### ① 附件/图片块 OPFS 上传与恢复 — `e2e/opfs-idb-survive.spec.ts`

1. `waitForApp` → 断言 `opfsAvailable()`；
2. 建文本块（标记「OPFS-恢复标记」）；
3. 注入真实大图（canvas 800×600 渐变 → PNG File）走真实 `drop` 管线（压缩→OPFS）；
4. 断言图片块 `image.src` 是 assetRef（非 `data:`/`blob:`），`listAssetRefs()` 含该 ref，
   `opfsHasAsset(ref) === true`；
5. `exportCurrent()` 捕获整份文档 JSON；`requestSave` 落 IndexedDB；
6. 用原生 indexedDB 清空 `docs/snapshots/trash` 三表（**不触碰 OPFS**）；
7. `reload()` 冷启动 → 仍断言 `opfsHasAsset(ref) === true`（OPFS blob 独立于 IndexedDB 存活）；
8. `importKbnoteText` 重新导入文档 JSON（仍引用同一 assetRef）→ 图片
   `naturalWidth > 0`、文本标记在 store 中回归。

实测日志：
```
BEFORE_CLEAR src= NBIhAE5vg4uk7icUNfqsk assetRefs= [ 'NBIhAE5vg4uk7icUNfqsk' ]
OPFS_BLOB_SURVIVED_IDB_CLEAR ref= NBIhAE5vg4uk7icUNfqsk
RESTORED_IMG src= NBIhAE5vg4uk7icUNfqsk
  1 passed
```

### ② WebDAV 401 / 断网错误路径 — `e2e/webdav-errors.spec.ts`

- **401**：`page.route('**/dav/**', fulfill 401)` → `syncStartWebdav` → `syncRunNow()` →
  断言 `[role=status]` 出现「认证失败，请检查用户名/密码」；本地标记块仍在、
  可再加一块（nodeCount 1→2）。
- **断网**：`page.route('**/dav/**', abort('failed'))` → 同上 →
  断言「无法连接服务器」toast；本地数据不丢、可编辑。

dav.mock 主机仅在 route 白名单内，零真实外网。实测：
```
GOT_401_TOOK    ✓ ① WebDAV 全量 401 → 认证失败 toast，本地仍可编辑
GOT_OFFLINE_TOOK ✓ ② route abort 模拟断网 → 无法连接 toast，本地数据不丢
  2 passed
```

## 7. 门禁

- `pnpm -r build`：通过；
- `pnpm typecheck` / `pnpm lint`（0 error）；
- `pnpm -r test`：core / web 单测只增不减；
- `E2E_PORT=4199 npx playwright test`：基线 75 passed +1 skipped 之上新增
  axe 8 例 + OPFS 1 例 + WebDAV 2 例，不回退；
- `OFFLINE_PORT=4207 npx playwright test --config playwright.offline.config.ts`：基线 4 passed 不回退；
- `node scripts/verify-precache.mjs`：通过。
