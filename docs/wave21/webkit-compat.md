# Wave21：Safari/WebKit 存储兼容兜底（配额检测 + 导出/分享引导）

## 背景

PWA 跑在 Safari（含 iPadOS）时，与 Chromium 存在三处关键差异：

1. **无 File System Access API**：`window.showOpenFilePicker` / `showSaveFilePicker` /
   `showDirectoryPicker` 全部不存在。此前 `web-host.ts` 已有 `<input type=file>` /
   `<a download>` 兜底，但缺少端到端验证。
2. **OPFS 支持参差**：`navigator.storage.getDirectory` 在旧版/隐私模式缺失或抛
   `NotAllowedError`（Wave20 已补图片 dataURL 内联与附件 toast）。
3. **存储配额无预警**：Safari 给站点的配额（通常 ~50MB/源）快满时，写入
   IndexedDB/OPFS 会抛 `QuotaExceededError`，此前只有一句 toast，没有引导用户导出。

本波补齐第三点，并把 WebKit 下的上传/下载/分享降级链路用独立 webkit 配置固化。

## 能力矩阵

| 能力 | Chromium | 桌面 Safari | 移动 Safari / iPadOS | 本机兜底 |
|---|---|---|---|---|
| FSA（showSaveFilePicker 等） | ✅ | ❌ | ❌ | `<input type=file>` / `<a download>` |
| OPFS（getDirectory） | ✅ | ⚠️ 参差 | ⚠️ 隐私模式拒绝 | 图片 dataURL 内联 + 附件 toast |
| `navigator.storage.estimate()` | ✅ | ✅(15.4+) | ✅ | 不支持 → 纯函数返回 `unavailable`，不猜 |
| `navigator.share` | ❌(桌面) | ❌ | ✅(iOS) | 无则 share() 自动降级下载 .kbnote/.kbpack |
| Tauri 桌面端 | — | — | — | **不弹浏览器引导**（host 门控，走原生 Save） |

## 改动清单

### 纯函数（零 DOM，vitest 覆盖）
`packages/web/src/storage/quota-policy.ts`：

- `quotaPressureRatio(usage, quota)`：非法输入（NaN/负/quota≤0）一律 0，不产 NaN；
- `classifyQuotaState(estimate)`：`unavailable | ok | low(≥80%) | critical(≥95%)`；
- `selectRecoveryActions({ isTauri, hasShare, fsaSupported })`：决定弹窗动作矩阵——
  Tauri → 空数组（不弹）；Web/PWA 恒有「导出 .kbnote」；有 Web Share → 给「分享…」，
  无 → 给「下载整库 .kbpack」；
- `formatBytes`：人类可读字节数。

已有的 `isQuotaError` / `estimateStorageQuota`（`storage/fsa.ts`）保留并继续单测。

### 产品代码
- `host/web-host.ts`：`share()` 在无 Web Share 或分享以非取消原因失败时，**不再静默**，
  自动降级为浏览器下载（text → .kbnote；file blob → .kbpack）。新增 `webCanShare()` 探测。
- `wiring/quota-watch.ts`：`raiseQuotaDialog()`（写入 QuotaExceededError 时拉起弹窗并补读
  estimate）、`checkQuotaPressure()`（启动预检，临界才弹、10 分钟节流；Tauri 内部 no-op）。
- `panels/StorageQuotaDialog.tsx`：「本地存储空间不足」引导弹窗，展示已用/配额/占用比，
  按能力矩阵渲染动作按钮；Tauri 端永不打开（quota-watch 门控）。
- `store/editor-store.ts`：FSA 配额钩子由 toast 改为拉起弹窗；bootstrap 末尾跑一次
  `checkQuotaPressure()` 预检。

### e2e
- `e2e/wave21-quota-compat.spec.ts`：**chromium 默认套件**回归（能力探测、弹窗动作矩阵、
  无 FSA 形下 .kbnote/.kbpack 下载真实触发、stub Web Share 后分享按钮真实调用）。
- `e2e/wave21-webkit-compat.spec.ts` + `playwright.webkit.config.ts`：**独立 webkit 配置**
  （project=webkit，testMatch 仅此 spec），覆盖 WebKit 无 FSA 上传/下载兜底、OPFS 不可用
  图片内联+附件 toast、配额弹窗动作。默认 `playwright.config.ts` 已把该 spec 加入
  testIgnore，chromium 套件不会误跑；web-ci 不改、也不调它。

## webkit e2e 本机实跑证据

**结论：webkit 引擎二进制已下载成功，但本机缺系统库无法启动，未跑通（按止损规则挂账）。**

- `PLAYWRIGHT_BROWSERS_PATH=/home/user/ms-playwright npx playwright install webkit`
  成功下载 WebKit 26.6 → `/home/user/ms-playwright/webkit-2359`。
- 启动实测（`webkit.launch({headless:true})`）失败：

```
minibrowser-wpe/bin/MiniBrowser: error while loading shared libraries:
  libgstcodecparsers-1.0.so.0: cannot open shared object file: No such file or directory
```
  完整缺失库（playwright host 校验）：`libgtk-4.so.1`、`libgstcodecparsers-1.0.so.0`、
  `libavif.so.13`、`libmanette-0.2.so.0`、`libsecret-1.so.0`。
- 本机无 sudo、系统目录只读，无法 `apt install` 这些系统库；全盘检索未发现可复用副本。

因此：webkit e2e spec 已写好但**本机未跑**；chromium 下同形降级路径（无 FSA/无 Share 的
addInitScript 模拟）已 4/4 通过，作为 WebKit 行为的等价代理。

## 手动走查步骤（真机 Safari / iPad 必做）

> 以下项本机自动化不了，挂账人工验证（连真机 Safari 打开 PWA）。

1. **上传兜底**：Safari 打开应用 → 顶部「文档 → 打开本地 .kbnote…」→ 应弹出系统文件
   选择器（而非无反应）→ 选一个 .kbnote → 正确打开。
2. **下载兜底**：「文档 → 导出 .kbnote」→ 应触发 .kbnote 下载到「下载项」。
3. **配额弹窗**：开发地址注入 `navigator.storage.estimate` 桩（usage/quota=0.99）或在
   Storage 几乎占满后写入失败 → 应弹「本地存储空间不足」弹窗，显示已用/配额/占用比；
   按钮为「导出当前文档(.kbnote)」+「下载整库备份(.kbpack)」（iPadOS 有 Web Share 时
   中间还会出现「分享…」）。
4. **分享兜底**：点「分享…」（iPadOS 真机）应唤起系统分享面板；在无 Web Share 的桌面
   Safari 应直接下载 .kbnote，不静默。
5. **OPFS 降级**：隐私窗口打开 → 拖入 PNG → 图片仍显示（dataURL 内联，reload 后在）；
   拖入 .pdf → toast 提示且不建坏块。
6. **Tauri 不弹**：桌面端写入失败时只走原生 Save，不出现浏览器这套弹窗（回归确认）。

## 挂账清单

- [ ] 真机 macOS Safari（最新）按「手动走查」1–5 全过。
- [ ] 真机 iPadOS Safari 按「手动走查」1–5 全过（重点验 Web Share 真面板）。
- [ ] 有 WebKit 系统依赖的 CI/本机 runner 上跑
  `WEBKIT_PORT=4190 npx playwright test --config=playwright.webkit.config.ts`，把结果回填本文件。
- [ ] 旧 Safari（<15.4，无 estimate()）验证弹窗用量区显示「未提供用量查询」兜底文案、不崩。
