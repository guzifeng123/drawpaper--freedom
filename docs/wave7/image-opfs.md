# Wave7 P2.1 — 图片统一压缩 → OPFS 落盘 → JSON 仅存 assetRefs 引用

把「粘贴 / 桌面拖入画布 / 斜杠菜单插入图片」三条入口收敛到**同一条压缩管线**，
图片 Blob 落 OPFS，文档 JSON 的图片块 `image.src` 只存 `assetRef` 引用 id
（与附件块同一登记形状），渲染经 objectURL 缓存；OPFS 不可用时降级 dataURL 内联。

## 1. 入口与管线

三条入口全部调用 `EditorApi.ingestImage(file, x, y)`（`packages/web/src/editor-api.ts`）：

| 入口 | 触发点 | 说明 |
| --- | --- | --- |
| 粘贴 | `editor/nodes/BlockShell.tsx` 的 `paste` 监听（编辑中的块） | clipboard image item → `ingestImage` |
| 拖入画布 | `editor/canvas/CanvasEditor.tsx` 的 `onDrop`（drop-classify 判 image） | `DataTransfer` File → `ingestImage` |
| 斜杠菜单 | `editor/tiptap/slash-menu.tsx`「图片」→ 隐藏 `<input type=file>` | 文件选择器 → `ingestImage` |

管线实现：`storage/image-pipeline.ts` 的 `ingestImageFile(deps, file, x, y)`：

```
compressImageBlob(file)
  → deps.putImageAsset(blob)            // core store：写 OPFS + 登记 doc.assetRefs
      成功且 assetRef 非空 → addImageBlock(assetRef, x, y)   via='opfs'
      空引用 / 抛错        → blobToDataUrl → addImageBlock(dataURL)  via='dataurl'
```

附件块（非图片）既有管线**未改动**，仍走 `putImageAsset`。

## 2. 默认参数（集中在 `storage/opfs.ts`）

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `IMAGE_MAX_LONG_EDGE` | `1600` px | 长边超过则等比降采样 |
| `IMAGE_OUTPUT_TYPE` | `image/webp` | 默认导出 mime |
| `IMAGE_OUTPUT_QUALITY` | `0.8` | webp 质量 |

### 格式选择矩阵（纯函数 `selectOutputMime(inputMime)`，单测覆盖）

| 输入 | 输出 | 理由 |
| --- | --- | --- |
| `image/svg+xml` | 原样不栅格化 | 矢量绝不经 canvas（会丢文字/路径），Blob 原样落 OPFS |
| `image/png` | `image/png` | 保留无损 + 原生 alpha 透明（仍按长边降采样像素网格） |
| jpg/gif/bmp/webp | `image/webp` q0.8 | 体积最优；webp 自带 alpha |

> 决策：透明 PNG 不转 webp 以保持无损透明（webp 虽支持 alpha，但 png 路径语义更直观、
> 避免重编码损失）。大图在主线程同步 canvas `drawImage` 降采样（未起 worker，保持简单；
> 1600px 长边在主流机 < 数十 ms）。

## 3. 存储形状

- Blob 经 `putAsset` 写入 OPFS 目录 `drawpaper-assets/<nanoid>`。
- 文档 JSON 图片块：`block.image = { src: assetRef, alt }`（`src` 不再是 dataURL）。
- 引用登记：core `putImageAsset` 把 `assetRef` 追加进 `doc.assetRefs[]`（undo 可撤销登记）。
- 渲染：`editor/nodes/use-resolved-image.ts` 的 `useResolvedImageSrc(src)`：
  - `data:` / `blob:` / `http` → 原样；
  - 否则视为 assetRef → `getAssetUrl(ref)`（objectURL 缓存，同 ref 复用）。
- 删除文档/回收站 purge 时沿 `doc.assetRefs` 清理 OPFS Blob（既有语义）。

### 降级矩阵

| 上下文 | 行为 |
| --- | --- |
| OPFS 可用（`navigator.storage.getDirectory`） | Blob 落 OPFS，`image.src=assetRef`，渲染走 objectURL |
| OPFS 不可用 / 写入失败 | 不落盘，`image.src=data:...` 内联（`via='dataurl'`），不产生坏引用 |
| 导出时 assetRef 读不到 | SVG 跳过该 `<image>`（不写裸 `assetRef` href），其余正常 |

降级分支由 `image-pipeline.test.ts` 覆盖：OPFS 返回空引用 / 抛错 → 断言 dataURL 内联且不抛。

## 4. 导出回归

- **SVG 矢量导出**（`export/svg-export.ts`）：图片块渲染 `<image href="data:...">`；
  `buildPagesSvgAsync` 先 `resolveImageHrefs(doc)` 把 assetRef 读成自包含 data URI。
  OPFS `getFile()` 不保留写入时 mime（文件名无扩展名 → octet-stream），
  `assetRefToDataUri` 按**魔数嗅探**修正为 `image/png|jpeg|webp|svg+xml`（`sniffImageMime`，单测覆盖）。
- **PrintSheets / 矢量 PDF（window.print）/ 位图 PNG·PDF（html-to-image）**：
  `PrintSheets.tsx` 现在对 `block.image` 渲染 `PrintNodeImage`（同样经 `useResolvedImageSrc` 解析成
  objectURL 的 `<img>`），DOM 里就是普通图片，打印与 html-to-image 自然抓到。
- e2e `acceptance-export.spec.ts` 全绿（矢量 PDF / 位图 PDF / PNG / 截图无回退）。

## 5. 测试计数

- core：**165**（未变）。
- web 单测：**199 → 213**（+14：`selectOutputMime` 3、`isAssetRefSrc` 3、`sniffImageMime` 2、
  `ingestImageFile` 降级 3、SVG 图片内嵌 3）。
- e2e：新增 `e2e/p21-image-opfs.spec.ts`（拖入/持久化/斜杠/导出四段，端口 4182）。

## 6. 关键文件

- `storage/opfs.ts`：常量、`selectOutputMime`、`isAssetRefSrc`、`sniffImageMime`、`assetRefToDataUri`、`compressImageBlob`。
- `storage/image-pipeline.ts`：统一摄入管线 + 降级。
- `editor/nodes/use-resolved-image.ts`：assetRef→objectURL 渲染解析。
- `export/svg-export.ts`：`<image>` 内嵌 + `resolveImageHrefs` / `buildPagesSvgAsync`。
- `wiring/dev-hooks.ts`：`buildSvgPagesDev()`（e2e 断言 SVG 内嵌图片）。
