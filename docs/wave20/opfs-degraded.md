# Wave20 S 路：OPFS 不可用端到端降级验证与加固

## 背景

OPFS（Origin Private File System）是图片/附件 Blob 的持久化后端。在以下环境中 OPFS 不可用：

- **非安全上下文**（http:// 非 localhost）；
- **旧浏览器**（不支持 `navigator.storage.getDirectory`）；
- **隐私/无痕模式**（getDirectory 存在但调用抛 `NotAllowedError`）。

此前只有 `opfs.ts` / `image-pipeline.ts` 的单元级覆盖，没有在真实「OPFS 不可用」环境下端到端跑过「建块 → 持久化 → 导出」整条链路。本路补 e2e + 修缺口。

## 降级契约

| 入口 | OPFS 可用 | OPFS 不可用 |
|---|---|---|
| 拖入画布图片 (.png/.jpg/…) | 压缩 → OPFS，`image.src` = 64-hex assetRef | 压缩 → data: URL 内联，`image.src` = `data:image/...;base64,...` |
| 斜杠菜单插入图片 | 同上 | 同上 |
| 粘贴图片（Tiptap 内） | 同上 | 同上 |
| 拖入画布附件 (.pdf/.zip/…) | 存 OPFS（注：当前 onDrop 不自动建块，预存行为） | **toast 提示 + 不建块、不落盘** |
| 附件块上传按钮 | 存 OPFS，`attachment.assetRef` = hash | wiring 层降级 dataURL 内联（块已存在，不新建坏块） |
| 导出 SVG/PDF | OPFS blob → data: URI 内嵌 | data: URL 原样内嵌（无需读 OPFS） |
| reload 持久化 | IDB 存文档 JSON + OPFS 存 blob | IDB 存文档 JSON（含内联 data: URL），无 OPFS 依赖 |

## 模拟手法

Playwright `context.addInitScript` 在页面脚本执行前覆写 `navigator.storage`，两种形态：

```ts
// 模式 A：navigator.storage 整体不存在（旧浏览器/非安全上下文）
await ctx.addInitScript(() => {
  delete (navigator as { storage?: unknown }).storage;
});

// 模式 B：getDirectory 存在但抛 NotAllowedError（隐私模式）
await ctx.addInitScript(() => {
  navigator.storage!.getDirectory = () =>
    Promise.reject(new DOMException('Not allowed', 'NotAllowedError'));
});
```

**不为此改 dev-hooks**——`isOpfsAvailable()` 只看函数存在性，模式 A 直接 false；模式 B 函数存在但运行时抛错，由 `putAsset` 内部 try/catch 兜住。

## 实测结果

e2e：`packages/web/e2e/wave20-opfs-degraded.spec.ts`

- **模式 A（navigator.storage 删除）**：
  - 斜杠菜单插入 PNG → 图片块渲染，`image.src` 以 `data:` 开头，`doc.assetRefs` 为空；
  - 画布拖入 PNG → 同样内联建块；
  - reload 后两张内联图片仍在（IDB 持久化，<img> naturalWidth > 0）；
  - `buildSvgPagesDev()` 产出的 SVG 含 `<image href="data:image/...">`；
  - 拖入伪造 .pdf → `role=status` toast 出现，节点数不变，无空 assetRef 坏附件块。
- **模式 B（getDirectory 抛 NotAllowedError）**：
  - 斜杠插入 PNG → data: 内联；
  - 拖入 .pdf → toast（CanvasEditor 识别 putImageAsset 返回的 data: 前缀），不建块。
- **(f) 正常上下文不回退**：不注入覆写时 `opfsAvailable()=true`，拖入 PNG 走 64-hex assetRef 路径。

## 修复的缺口

### `CanvasEditor.tsx` onDrop 附件分支

原代码：
```ts
if (!api.putImageAsset) { toast('不支持附件'); continue; }
await api.putImageAsset(f);
```

`api.putImageAsset` 在生产 wiring 中**始终定义**，所以 `if (!api.putImageAsset)` 永远不成立——OPFS 不可用时拖入附件静默无反馈。修复：

1. 先查 `isOpfsAvailable()`：false → toast + continue（模式 A）；
2. true 时调 `api.putImageAsset(f)`，检查返回的 `assetRef` 是否以 `data:` 开头——若是说明 wiring 层运行时降级了（模式 B：getDirectory 抛错），同样 toast + continue，不建块。

最小改动，不动 `opfs.ts` / `image-pipeline.ts` / core。

## 单测加固

`image-pipeline.test.ts` 新增：

- `OpfsUnavailableError` 专用错误 → dataURL 降级，断言 src 不匹配 `/^[0-9a-f]{64}$/`（不泄漏 OPFS ref）；
- 正常 OPFS 路径返回 64-hex → via=opfs（对照）；
- 坏 blob（text/plain mime）不炸，仍产出 data: URL。

## 红线自检

- [x] 只推 `fix/asset-opfs-degraded`，未碰 develop/main/tag/版本号；
- [x] 未改 workflow；
- [x] 未动同步/协作/桌面外壳代码；
- [x] 零外网（全部用本地 1x1 PNG + 伪造 PDF 字节）；
- [x] 未引新依赖；
- [x] core 零 DOM（改的是 web 层 CanvasEditor）。
