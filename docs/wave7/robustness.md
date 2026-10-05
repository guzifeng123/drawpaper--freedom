# Wave7 P2.1 边角健壮性收口

本波次收口四项边角健壮性：FSA 兜底、OPFS 不可用降级、表格拖选合并、10k 块性能。
本文记录结论、自动化覆盖与**人工验证清单**（headless 无法稳定模拟的浏览器差异）。

基线（origin/develop 9d16fd4）：core 165 / web 199 单测，e2e 43。
本波次后：core 165 / web 213 单测（+14），e2e 44（+1：table-drag-merge；bench 默认 skip 不计入门禁）。

---

## 1. Safari/Firefox 无 File System Access API 兜底

### 结论
- `WebHostAdapter`（`packages/web/src/host/web-host.ts`）在 `showOpenFilePicker/showSaveFilePicker`
  缺失时已有完整降级：
  - 打开 → `<input type=file accept=".kbnote">`（`openViaInput`）；
  - 另存/导出 → `<a download="*.kbnote">` + `Blob` + `URL.createObjectURL`（`downloadViaAnchor`）。
- FSA 层（`packages/web/src/storage/fsa.ts`）新增配额感知：
  - `isQuotaError()` 识别 `QuotaExceededError` / `NS_ERROR_FILE_NO_DEVICE_SPACE` / enospc；
  - `estimateStorageQuota()` 读 `navigator.storage.estimate()`；
  - `writeActiveFile/saveFileAs/saveWithFsa` 的 catch 区分 AbortError（用户取消，静默）与
    配额/写盘失败，经 `setStorageQuotaWarningHook` 通知接线层。
- `editor-store.ts` 挂载钩子：配额不足 → `pushToast('error', ...)`；普通写盘失败 → `pushToast('warn', ...)`，
  且另存路径仍会走 host 的 anchor 下载兜底（不静默失败）。

### 自动化覆盖（vitest，+11）
- `packages/web/src/storage/fsa.test.ts`（8）：
  - jsdom 无 FSA 时 `openWithFsa→null` / `saveWithFsa→false`；
  - `isQuotaError` 识别；
  - mock `showSaveFilePicker` 抛 QuotaExceededError → 通知钩子收到 `'quota'`；
  - AbortError 静默；普通写盘失败 → `'write-failed'`；
  - `ActiveFileManager.writeActiveFile` 注入抛配额错的句柄 → 通知；
  - `estimateStorageQuota` 有/无 `navigator.storage.estimate` 两分支。
- `packages/web/src/host/web-host.test.ts`（3）：
  - FSA 返回 null 后走 `<input type=file>` 读取并返回 `{name,text}`；
  - FSA 返回 false 后走 `<a download>`（断言 download 后缀、blob href、click）；
  - 无 `navigator.share` 时 `share()` 静默不抛。

### 人工验证清单（headless 无法稳定模拟）
> Chrome headless 始终带 File System Access API；Safari/Firefox 差异需真机/真浏览器手验。

1. **Safari 17+（macOS）**
   - 打开站点（HTTPS 或 localhost）→ 菜单「打开 .kbnote」：弹出系统文件选择框（非 FSA），
     选择后内容正确载入。
   - 「导出/另存为 .kbnote」：触发浏览器下载（Documents/下载文件夹出现 *.kbnote），不报错、不卡住。
   - 预期：全程无 toast「写入失败」（anchor 下载成功）。
2. **Firefox 120+**
   - 同 Safari 两项；Firefox 无 `showSaveFilePicker`，应直接走 anchor 下载。
3. **配额不足提示（任意 Chromium，DevTools 模拟）**
   - DevTools → Application → Storage → 把配额调到极小；或在 Console 临时让
     `showSaveFilePicker` 的 `createWritable` 抛 `QuotaExceededError`。
   - 触发另存：应看到右下角红色 toast「浏览器存储配额不足…」，且仍有 anchor 下载产物。
4. **取消保存**：另存对话框点取消 → 无 toast、无报错（AbortError 静默）。

---

## 2. 附件 OPFS 不可用 → dataURL 内联降级

### 结论
- **未改 `opfs.ts` 生产代码**（另一路并行在改）。不可用状态通过注入 `storage.putAsset`
  抛 `OpfsUnavailableError` 模拟（与 `DexieStorageAdapter` 在 `navigator.storage.getDirectory`
  缺失时抛错同形）。
- 最小接线层改动（`packages/web/src/wiring/create-editor-api.ts`）：
  `putImageAsset` 在 core 返回空 assetRef（OPFS 失败）时，用 `FileReader.readAsDataURL`
  把文件内联为 `data:` URL 返回。附件块把该 dataURL 写进块 content，随文档 JSON 持久化。
- OPFS 成功路径不变：返回 OPFS ref 并登记 `doc.assetRefs`。

### 自动化覆盖（vitest 集成测试，+3）
- `packages/web/src/wiring/put-asset-downgrade.test.ts`：
  1. OPFS 不可用 → `putImageAsset` 返回 `data:` 开头 assetRef，`doc.assetRefs` 不登记幽灵 ref；
  2. dataURL 经 `serializeKBNote → parseKBNote` 往返后仍在，且 `atob` 解码回原始字节（reload 不丢）；
  3. 对照：OPFS 可用时返回 OPFS ref 并登记 `assetRefs`（不回退 dataURL）。

### 说明
- e2e 真机「OPFS 不可用」在 Chromium 下无法稳定构造（始终有 OPFS），故用接线层集成测试 +
  注入错误适配器 monkeypatch，符合任务允许的「测试层 monkeypatch」。
- 现有 OPFS happy-path e2e（`fix-editor.spec.ts` 附件上传 → `opfsHasAsset` → reload 仍在）未改、仍绿。

---

## 3. 表格单元格鼠标拖选合并/拆分

### 结论
- **e2e 保留**（`packages/web/e2e/table-drag-merge.spec.ts`），连续 3 次运行全绿：
  灌一个内容已是 2×2 表格的夹具（`addNode('table')` 只建空段落，不预置表格网格，故夹具自带表格 JSON）
  → 双击进入 Tiptap 编辑态 → `mouse.down` 首格 → 移动过第二格 → `up` 触发 ProseMirror CellSelection
  → 「合并」按钮由禁用变可用 → 点击后出现 `[colspan="2"]` → 「拆分」后消失。
- 命令层单测（`table-ops.test.tsx`，Wave5b 已有）覆盖 CellSelection→merge→colspan=2→split 语义；
  e2e 额外覆盖真实鼠标拖选时序。

### 人工验证清单（补充）
- 在真机 Chrome 里手动拖选两个相邻单元格（非 Shift+Click），确认「合并」启用、合并后 colspan=2、
  「拆分」还原。e2e 已自动化，此条仅作回归兜底。

---

## 4. 性能
见 [perf-10k.md](./perf-10k.md)。
