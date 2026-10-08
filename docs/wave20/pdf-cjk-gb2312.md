# Wave20 · 矢量 PDF 内嵌中文字库扩到 GB2312 全字库

把「直接下载矢量 PDF」内嵌的中文字体 **VecCJK** 从 GB2312 一级常用字
（3755 字）扩到 **GB2312 一级+二级全部汉字（6763 字）**，收敛「含二级生僻字
的文档被迫回退位图 PDF」的范围。只做这一条。

## 1. 覆盖字集（构建期选定的码位）

产物 `packages/web/src/export/assets/vector-cjk.ttf` 覆盖以下码位并集
（共 **6995** 个，cmap 为 BMP format-4）：

| 部分 | 范围 | 数量 |
|---|---|---|
| ASCII | U+0020..U+007E | 95 |
| 既有全角/CJK 符号标点 | U+3000..U+303E 一带、U+FF01..U+FF5E、U+FFE0..U+FFE6 | 131 |
| **GB2312 一级常用字** | 16..55 区 | 3755 |
| **GB2312 二级次常用字** | 56..87 区 | 3008 |
| 回归锚点「龘」 | U+9F98 | 1 |

- GB2312 汉字来源：GB2312-80 的 94×94 区位表。脚本对每个区位
  `(row in 16..87, col in 1..94)` 拼出字节 `(row+0xA0, col+0xA0)`，用 Python
  标准库 `gb2312` codec 解码回 Unicode——这是 GB2312→Unicode 的权威映射，
  不依赖外部码表文件。枚举结果恰为 **6763** 个唯一 BMP 码位。
- 全角/符号集：从「上一版」`vector-cjk-cmap.json` 里读出所有非 CJK 统一表意
  （U+4E00..U+9FFF）的码位原样继承，保证 Wave14 已支持的全角字符一个不丢。

### 关于「龘」的说明（诚实记录）

龘（U+9F98）**严格说并不在 GB2312-80 的 6763 字网格内**：它在 gb18030 下编码为
`0xFD93`（区位 93），超出 GB2312-80 止于 87 区（0xF7）的范围，属 GBK 扩展字。
它之所以被纳入，是因为它长期作为本产品「生僻字」的 **e2e 回归锚点**（Wave14 曾用它
验证回退兜底），且只多 1 个字形（约 0.3KB）。纳入后，「含龘文档被迫回退位图」这一
本波正是要收敛的场景不会重新出现。

真正超纲的字符——**CJK 扩展 B（U+20000 起，超出 BMP）**，如「𠮷」U+20BB7——
仍不在 cmap（format-4 只覆盖 BMP），继续走缺字形预检→位图回退兜底，见 §4。

## 2. 构建 / 再生成

脚本：`packages/web/scripts/build-vec-cjk-font.py`（可重复运行、幂等）。

```bash
# 依赖：python3 + fontTools(4.64) + cu2qu(1.6)（构建机已装，不联网、不下载字体）
python3 packages/web/scripts/build-vec-cjk-font.py
```

产出（覆盖）：
- `packages/web/src/export/assets/vector-cjk.ttf`
- `packages/web/src/export/assets/vector-cjk-cmap.json`（按 `{ranges:[[lo,hi],...]}`
  从新字体 cmap 重新生成，被 `vector-pdf-export.ts` 的 `getCoverageSet` 消费）

管线（复刻既有字体规格）：
1. 从 `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc` 取 SC 面
   （`fontNumber=2`，CFF 轮廓，unitsPerEm=1000）。
2. `pyftsubset` 按上述码位子集化（`.notdef` 带轮廓、recalcBBoxes、不留字形名）。
3. `Cu2QuPen`（max_err=1.0 font 单位）把 CFF 三次贝塞尔二次曲线化为 glyf 轮廓。
4. 删除 CFF/VORG 及 jsPDF 用不到的 `vhea/vmtx/BASE/GPOS/GSUB/GDEF`（jsPDF+svg2pdf
   只消费 cmap→glyf 轮廓 + hmtx advance width；删除既省体积又不改变任何可见字形或
   字宽）。
5. maxp 升 1.0、post 设 3.0、unitsPerEm 保持 1000、OS/2.usWeightClass=400、
   name 表 1/4/6/16 改为 `VecCJK`。
6. 自检：龘在 cmap 且有轮廓、目标码位全覆盖、无可见空字形后才落盘。

许可：源字体为 Noto Sans CJK（SIL OFL-1.1），派生字体改名 VecCJK（未沿用
Reserved Font Name）。OFL 正文与派生说明见同目录 `LICENSE-VecCJK.txt`（已同步更新
字集描述）。

## 3. 体积影响（实测）

| | 旧（一级字库） | 新（GB2312 全字库） |
|---|---|---|
| cmap 码位数 | 3986 | 6995 |
| `vector-cjk.ttf` 字节数 | 2,184,368 | **1,959,380** |
| 相对 precache 单文件上限 | — | 1.87 MiB / 4.00 MiB（达标） |

字多了 75%（3008 个二级字），但 ttf 反而更小：因为本次删除了 GSUB（~30KB）、
vmtx（~15KB）、BASE/GPOS 并把 post 从 2.0（带字形名）降到 3.0（省 ~80KB），
这些表 jsPDF 根本不读。

打包形态：`vector-pdf-export.ts` 用 `import vectorFontUrl from './assets/vector-cjk.ttf?url'`，
构建后为独立 hashed 资源（如 `vector-cjk-Cnu6c7D1.ttf`），**未内联进主 chunk**；
且随 `import('jspdf')`/`import('svg2pdf.js')` 一起在用户点「直接下载 PDF（矢量）」时
才懒加载获取，不进首包。该 ttf 由 vite-plugin-pwa 的 `globPatterns` 预缓存
（`maximumFileSizeToCacheInBytes = 4 MiB`），离线可用。

## 4. 矢量 / 位图分流策略

`assertNoMissingGlyphs`（`vector-pdf-export.ts`）在渲染前扫描所有导出文本：
非 ASCII 且不在 cmap 的字符即抛 `MISSING_GLYPH_MARKER`，由调用方
（`useExportModel`）整体回退位图 PDF 并 toast「含字体不支持的文字，已回退位图模式」，
避免交付缺字 PDF。扩字库后：

- **原本回退的二级生僻字**（龘等 6763 个 GB2312 汉字）→ 现在矢量直出，
  内嵌 CID TrueType 字体（`pdffonts` emb=yes/uni=yes），文本对象可选可复制、
  `pdftotext`/pdfjs 能抽取出字。
- **真正超纲的字**（CJK Ext-B 等 BMP 外字符，如 𠮷 U+20BB7）→ 仍命中预检、
  回退位图 + 专门 toast，兜底未被破坏。

## 5. 门禁与实测结论

- `pnpm -r build`：通过；字体为独立 hashed asset，未内联。
- `node scripts/verify-precache.mjs`：通过（全部构建产物含字体在 precache 清单）。
- `pnpm typecheck` / `pnpm lint` / `CI=true pnpm -r test`：通过。
- e2e `vector-pdf.spec.ts`：4/4 绿——
  ①矢量主线（字体内嵌、中英文可抽取、图片光栅）；②强制矢量失败回退位图；
  ③**龘文档矢量直出成功（pdfjs 抽出「龘」、字体引用数>0、无回退 toast）**；
  ④**𠮷（Ext-B）文档仍命中预检回退位图 + 专门 toast**。
- 离线 e2e（`playwright.offline.config.ts`）：4/4 绿。

红线自检：零运行时外网（字体为本地构建产物，非 CDN）；未引运行时新依赖
（构建脚本仅用 python 标准库 + 已装 fonttools/cu2qu）；core 零 DOM；不做 Android；
未碰 workflow/版本号/已发布 CHANGELOG 段。
