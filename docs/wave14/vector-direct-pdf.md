# Wave14·E 路：直接下载 PDF 升级为矢量模式

> 范围：仅导出链路（`packages/web/src/export/**`）。位图直下载保留为兜底，Ctrl+P 浏览器打印管线一行未动。

## 1. 背景与目标

此前「直接下载 PDF」是**位图模式**：逐页把已排版的 `.sheet` DOM 用 `html-to-image` 栅格成 PNG（pixelRatio 3），再用 pdf-lib `embedPng` 合成多页 PDF。文字不可选、不可搜、放大模糊。

本路把同一分页排版（fit/tiles/flow、A4 纵/横、页边距、页眉页脚页码、手动分页符、折叠子树不导出等既有选项全部保持）升级为**矢量直下载**：每页渲染为 SVG，再用 svg2pdf.js 画成真正的矢量 PDF——节点/边/续接标记为矢量路径，文字为文本对象（可选、可搜索、可复制），图片块光栅嵌入。

## 2. 依赖核实（证据）

| 依赖 | 版本 | License | 说明 |
|---|---|---|---|
| `svg2pdf.js` | **2.8.1** | **MIT** | SVG→PDF 渲染器。实测其 peerDep 为 `jspdf`，即它是 jsPDF 插件——必须直接依赖 jsPDF 作为渲染后端（见 §5）。 |
| `jspdf` | **2.5.2** | MIT | svg2pdf 的渲染后端；仅作 svg2pdf 画布，不引入其高层 API。 |
| `pdf-lib` | ^1.17.1（既有） | MIT | 位图兜底链路继续使用；矢量主线走 jsPDF。 |

**体积（构建后独立懒 chunk，不进主包）：**

```
dist/assets/svg2pdf.es.min-*.js   87.10 kB │ gzip 25.67 kB
dist/assets/jspdf.es.min-*.js    357.93 kB │ gzip 118.12 kB
dist/assets/vector-cjk-*.ttf    2447.21 kB │ （CJK 字体子集，见 §4）
```

三者均为动态 `import()` 懒加载，与 pdf-lib / html-to-image 同模式；首包 `index-*.js` 不含它们。

## 3. 矢量渲染管线

```
PaginateResult + KBNoteDoc
  └─ buildPagesSvgAsync(...)        ← 与「下载 .svg」同源（svg-export.ts）
       逐页 SVG 字符串（节点矩形/贝塞尔边/续接圆/页眉页脚/图片 <image>）
  └─ DOMParser 解析每页 SVG
       ├─ injectFontFamily()：给所有 <text> 注入 font-family="VecCJK"
       ├─ extractAndStripImages()：剥离 <image>，记录矩形 + data: URI（见 §6）
       └─ svg2pdf(svgEl, jsDoc, {width:A4_PT.x, height:A4_PT.y})
            → 矢量路径 + 文本对象画入当前 jsPDF 页
       └─ 每页 addPage() 续接，最后 jsDoc.output('arraybuffer') → Blob
```

- **坐标缩放**：SVG 以 `pagePixelSize`（A4 96dpi，纵 794×1123 px）为 viewBox；svg2pdf 的 `{width,height}` 设为 A4 pt（595.28×841.89），自动等比缩放到 PDF pt。图片用同一缩放比换算。
- **与打印管线分工**：Ctrl+P / 浏览器「另存为 PDF」走打印 CSS（矢量、文字可选），本路一行未动；直下载矢量是独立链路，复用同一 `PaginateResult`，故页数/孤块黄标/续接标记/零切割等硬规则与位图版逐一对齐。

## 4. 中文文本为何必须嵌入字体（关键）

实测：jsPDF 标准 14 字体（Helvetica/Times/Courier）用 **WinAnsi 编码**，无法内嵌中文——
用默认字体输出 `你好世界`，pdftotext 抽到的是乱码 `O\`Y}NuL`，且字体未嵌入。

**最终字体：VecCJK = Noto Sans CJK SC Regular 子集（SIL OFL-1.1）。**
- Noto Sans CJK 原生是 **CFF/OTF 轮廓**，jsPDF 的 TTF 解析器只认 **glyf(TrueType)** 轮廓，
  CFF 字体会在 `glyphFor` 处抛错（实测）。
- 处理管线：从 `NotoSansCJK-Regular.ttc` 抽 SC 面（index 2）→ 用 **fontTools + cu2qu**
  把 CFF 三次贝塞尔轮廓转成 glyf 二次轮廓（`Cu2QuPen`，max err 1.0）→ pyftsubset 子集化。
- 子集范围：GB2312 一级常用字（3755 个汉字）+ ASCII + 全角/常用标点，共 3986 字形，
  产物 2.18 MB < workbox `maximumFileSizeToCacheInBytes`（4 MiB）上限，能进 SW 预缓存、离线可用。
- 注册：`pdf.addFileToVFS('vec-cjk.ttf', base64)` + `pdf.addFont('vec-cjk.ttf','VecCJK','normal')`；
  svg2pdf 字体解析在 `pdf.getFontList()` 按 `font-family="VecCJK"` 命中，文本成为带 ToUnicode CMap 的 CID TrueType。
- 字体族改名 VecCJK（Noto 是 OFL、无 Reserved Font Name 限制；改名便于标识派生子集）。

> 历史：初版曾用 AR PL UMing CN（文鼎，Arphic Public License，类 copyleft），因缺许可证声明不合规，
> 已改用 OFL 的 Noto 子集。字体许可证见 §11。

## 5. svg2pdf 与 jsPDF 的关系（纠偏）

规划稿称「svg2pdf 把 SVG 画进 pdf-lib 页面，jsPDF 不需要」。实测修正：**svg2pdf.js 2.8.1 是 jsPDF 插件**（其 peerDependency 即 jspdf，导出 `svg2pdf(element, pdf, options)`，pdf 必须是 jsPDF 实例）。因此矢量主线的多页容器是 jsPDF，而非 pdf-lib；pdf-lib 仅保留在位图兜底链路。jsPDF 与 svg2pdf 同为动态 import 懒加载。

## 6. 图片栅格策略

svg2pdf 直接光栅 SVG `<image>` 在本环境会**挂起**（实测含图片节点的页面永不 resolve，导致无回退）。稳妥方案：
1. 渲染前把 `<image>` 从 SVG DOM 剥离，记录 `{x,y,w,h,dataUri}`；
2. svg2pdf 只画矢量形状与文字；
3. 图片在浏览器侧 `new Image()` + `Image.decode()` 解码到 `<canvas>`（绕过 jsPDF 直接吃 data: URI 字符串时的卡死路径），再 `pdf.addImage(canvas,'PNG',x,y,w,h)` 按缩放比嵌入。

e2e 用含图片块文档验证：`pdfimages -list` 在对应页列出 image XObject。

## 7. 兜底路径（不静默）

`useExportModel.onExportPdf`：先尝试矢量主线；**任何**矢量失败（懒 chunk 加载失败 / 字体 fetch 失败 / 单页 svg2pdf 抛错）都 `pushToast('error','矢量导出失败，已回退位图模式')` 并自动走既有 `renderSheetsAsPdf`（html-to-image → pdf-lib embedPng）产出 PDF。位图代码一行未删。导出对话框仍为单一「直接下载 PDF」按钮（默认矢量、自动兜底）。

### 7.1 缺字形预检（避免静默缺字）

内嵌字体仅覆盖 GB2312 一级常用字。正文若含二级生僻字（如「龘」U+9F98），矢量 PDF 会静默缺字（空白）。为此：
- 构建期从字体 cmap 导出覆盖区间表 `assets/vector-cjk-cmap.json`；
- 渲染前 `assertNoMissingGlyphs()` 扫描所有页 SVG 的 `<text>` 文本，凡**非 ASCII 且不在 cmap** 的字符即判定为缺字形；
- 命中则抛 `__MISSING_GLYPH__` 标记错误，`useExportModel` 用专门文案 toast「**含字体不支持的文字，已回退位图模式**」并整体回退位图（位图链路用系统字体渲染，不缺字）。
- e2e：构造含「龘」的文档，断言该 toast 出现且仍产出 PDF。

> 边界：常用简体字（GB2312 一级 3755 字）覆盖良好；二级罕用字/繁体字/扩展 B 区会触发回退而非缺字。生僻字长期需求请走 Ctrl+P「打印为 PDF」（系统字体，全字符覆盖）。

## 8. 懒加载与离线

- jspdf / svg2pdf / CJK 字体均动态 import，不进主 chunk。
- 构建后 `verify-precache.mjs` 通过：新 chunk 与 `vector-cjk-*.ttf` 均在 SW precache 清单（precache 92 条 / 7016 KiB）。
- 离线 e2e（`OFFLINE_PORT=4228`）四条全绿：矢量 PDF 导出在断网下可用（懒加载包已预缓存）。

## 9. 字体验证方法与实测输出

环境具备 poppler-utils（`pdffonts` / `pdftotext` / `pdfimages` / `pdfinfo`）。对标准样例（纵向 tiles，9 页）导出的矢量 PDF 实测：

```
$ pdffonts vector-direct.pdf
name    type           encoding    emb sub uni
VecCJK  CID TrueType   Identity-H  yes no  yes

$ pdftotext vector-direct.pdf - | grep ...
bullet#3
note#20
孤块-无连接
...

$ pdfinfo vector-direct.pdf | grep Pages
Pages: 9        # 与 .drawpaper-print-container .sheet 数一致

$ pdfimages -list vector-direct.pdf
page  num  type   width height ...
 4    0    image  1     1      ...   # 图片块光栅可见
```

- `emb=yes`：字体已嵌入；`uni=yes`：带 ToUnicode CMap，可抽取。
- 中文（`孤块-无连接`）与英文节点正文（`bullet#3`/`note#20`）均可被 pdftotext 抽出 → 文本对象可选可复制，非整页栅格。

## 10. 门禁

- `pnpm -r build` ✓（新懒 chunk + 字体进 assets）
- `pnpm typecheck` ✓ / `pnpm lint` 0 error ✓
- `CI=true pnpm -r test`：core 273 / web 320（不增不减）✓
- `E2E_PORT=4227` 全量 playwright：92 基线 + 本路新增 3 条（矢量产物实测 / 强制失败回退 / 生僻字缺字形回退）无回退 ✓
- `OFFLINE_PORT=4228` 离线 4 条 ✓
- `node scripts/verify-precache.mjs` ✓

## 11. 字体许可（合规）

| 资产 | 许可证 | 版权人 | 声明文件 |
|---|---|---|---|
| `assets/vector-cjk.ttf`（VecCJK 子集） | **SIL Open Font License 1.1** | Noto Sans CJK SC：Copyright 2014-2021 Google LLC | `assets/LICENSE-VecCJK.txt` |

要点：
- OFL-1.1 允许子集化后**捆绑/嵌入 PDF/再分发**，且不要求开源宿主软件；修改（子集）后须以 OFL 分发并保留版权与许可声明。
- 子集 TTF 本体 + 许可证文本同目录存放，即满足「修改版字体可获取」义务。
- Noto 无 Reserved Font Name 限制；派生字体已改名 VecCJK，未沿用原族名。
- 无 copyleft 传染：字体嵌入 PDF/打包 Web 均不触发对 drawpaper 源码的开源要求。
