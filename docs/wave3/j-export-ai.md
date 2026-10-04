# Wave3-J · P1 导出格式补齐 与 AI 辅助全链路

> 范围（`git diff develop --stat`）：
> - `packages/core/src/paginate/`（手动分页符 + 框选 bbox 过滤）
> - **新建** `packages/core/src/ai/`（纯逻辑，零 DOM）
> - `packages/core/src/index.ts`、`packages/core/package.json`（根 barrel + `./ai` 子路径）
> - `packages/web/src/export/`（SVG / Markdown / tiptap→md）
> - **新建** `packages/web/src/ai/`（provider / client / 设置·面板·diff 弹窗）
> - 本文档。

## 1. 导出格式补齐

### 1.1 手动分页符（PageSettings.pageBreaks）
- 复用既有 `model/page.ts` 的 `PageBreak { at: number }`（**未改 model**，该模块归 wave1-a）。
- **Flow**：把分页符解释为「打印流的全局 y」。遍历时维护 `streamY` 与 `pageStartStreamY`；当某个未消费的分页线落在 `[pageStartStreamY, item.streamY]` 区间内，强制 `startNewPage()`，该块成为新页首。widow/orphan 簇规则仍然生效（先手动切页、再自然翻页）。
- **Tiles**：后处理切页。纵向页（portrait）沿 y 横切、横向页（landscape）沿 x 竖切；把「内部含分页线」的页按分号线切成多带，节点按中心落带（不切节点，零切割硬规则），跨带边退化为续接标记。
- **Fit**：单页不适配分页符（语义上 fit=一页总览，忽略）。

### 1.2 导出选中区域（scopeBBox）
- `PaginateInput.scopeBBox?: {x,y,width,height}`，与 `scopeNodeIds` 叠加取交集。
- 在 `activeNodeSet` 里对每个候选节点做轴对齐矩形相交测试（`rectsIntersect`），不相交者剔除，并在 `notes` 里计数。

### 1.3 SVG 矢量导出（`web/src/export/svg-export.ts`）
- `buildPagesSvg(result, doc, {orientation, gray})`：逐页纯字符串构建 `<svg>`。
  - 节点：`<rect>` + 块内纯文本前几行（复用 core `extractNodePlainText`）；
  - 边：三次贝塞尔 + `<marker id="arrow">` 箭头；
  - 续接：`<circle>` + token 编号；页眉/页脚文本。
- `downloadSvgPages`：每页一个 `.svg` 直接下载（**不打 zip、不引依赖**）。

### 1.4 Markdown 大纲导出（`web/src/export/markdown-export.ts`）
- `tiptapToMarkdown`（`render/tiptap-to-markdown.ts`）：标题 `#`、列表 `-`、有序 `1.`、待办 `- [ ]/[x]`、引用 `>`、代码 ```、图片占位 `![alt](src)`、行内 bold/italic/code/link。
- `docToMarkdown`：core `buildMainTree` DFS，根=一级标题逐级降级；todo/bullet 行内化；note 转引用块；图片只留占位链接（附件本体在 OPFS）。
- `downloadTextFile`：Blob + `<a download>` 落 `.md`。

### 1.5 PDF 直接下载（无回归）
- 未改 `print-pipeline.ts`（pdf-lib + html-to-image）；`useExportModel` 三模式端到端沿用 Wave2。
- core 94 测试（含 acceptance 三模式零切割像素断言）全绿。

## 2. core AI 纯逻辑（`packages/core/src/ai/`，零 DOM）

| 文件 | 导出 | 职责 |
|---|---|---|
| `suggestion-schema.ts` | `validateAiOutput(raw, knownIds)` | zod 判别联合校验 5 类建议；丢非法条、保留合法条，`errors` 计数说明 |
| `prompts.ts` | `buildAiMessages(doc, task)`、`extractNodePlainText` | 5 类任务的 system/user prompt；列出全部节点 id+文本片段+现有边，禁臆造 id |
| `apply-ai-diff.ts` | `applyAiSuggestions(doc, suggestions, accepted)` | 纯函数落库：add-edge 去重建边 / group 建容器并 reparent / split 建兄弟块 / summarize 替换文本 / set-root 仅标注 notes |
| `gap-detect.ts` | `detectAiGaps(doc)` | 空叶子块、孤立连通分量、游离块、多根森林 → `AiGap[]` |

- 根 barrel `@drawpaper/core` 与子路径 `@drawpaper/core/ai` 均导出；类型名刻意用 `AiSuggestion`（与 adapters 宽松的 `AISuggestion` 区分，避免 barrel 冲突）。
- **未改** `store/adapters.ts`（归存储 agent）。其 `applyAIDiff` stub 仍在；见 §5 接线点。

### 2.1 输出 Schema（模型必须吐的 JSON）
```json
[
  {"kind":"add-edge","reason":"…","source":"n_1","target":"n_2","label":"可选"},
  {"kind":"set-root","reason":"…","rootNodeId":"n_1"},
  {"kind":"group","reason":"…","memberNodeIds":["n_1","n_2"],"title":"可选"},
  {"kind":"split-block","reason":"…","targetNodeId":"n_1","afterText":"新段落"},
  {"kind":"summarize","reason":"…","targetNodeId":"n_1","newText":"凝练文本"}
]
```
- 端点 id 必须来自 prompt 给出的清单；自环、缺 reason、臆造 id 一律丢弃。

## 3. web AI（`packages/web/src/ai/`，允许 DOM/fetch）

| 文件 | 职责 |
|---|---|
| `ai-settings.ts` | endpoint/key/model/temperature 存 localStorage；5 家 OpenAI 兼容端点预设（OpenAI/豆包/DeepSeek/通义/Kimi）仅作占位文案 |
| `openai-provider.ts` | 原生 fetch `{endpoint}/chat/completions`，实现 core `AIProvider` |
| `ai-client.ts` | 编排：buildMessages → chat → `extractJson`（剥 ```json 围栏）→ `validateAiOutput`；任何失败返回失败态、**不改文档** |
| `ai-api.ts` | 结构型接口 `AiApi`（applyAISuggestions / addManualPageBreak / removePageBreak）+ `createMockAiApi` |
| `AiSettingsDialog.tsx` | 设置表单 +「测试连接」+ 隐私说明 |
| `AiPanel.tsx` | 五个动作按钮 + busy 态 + 结果进 diff |
| `AiDiffDialog.tsx` | 类型图标/理由/涉及节点/逐条勾选/全选 |

- **零网络核查**：除用户配置 endpoint 的主动请求外，代码无其他 fetch/CDN。
- key 仅存本机浏览器；成功合入后提示用户手动「一键整理」布局。

## 4. 失败回退矩阵

| 阶段 | 失败 | 行为 |
|---|---|---|
| 配置缺失 | 无 endpoint/key/model | 弹设置窗 + toast，不发请求 |
| 网络/HTTP | fetch reject / !ok | toast 错误，文档不变 |
| 解析 | 输出非 JSON / ```json 外噪音 | `extractJson` 抛错 → 失败态 |
| 校验 | 臆造 id / 缺 reason / 自环 | 非法条丢弃、合法条进 diff；全非法则失败 |
| 勾选合入 | 端点缺失 / 重复边 | 该条 skipped，其余照常；返回 `{doc, applied, skipped, notes}` |

## 5. 需要 Wave4 接线点

1. **store 动作**：把 `web/src/ai/ai-api.ts` 的 `AiApi` 接真实 store：
   - `applyAISuggestions` → 调 core `applyAiSuggestions(doc, suggestions, accepted)` 得到新 doc，包成 Command 落库；
   - `addManualPageBreak({id,x,y})` / `removePageBreak(id)` → 写 `doc.page.pageBreaks`。
2. **面板挂载**：在合适面板（如右侧 AI 面板区）挂 `<AiPanel doc={doc} api={aiApi} />`。
3. **ai-adapters re-export**：Wave4 可在 store 层把 `applyAIDiff` stub 委托给 core `applyAiSuggestions`（本模块不碰 adapters.ts）。
4. **合入后布局**：建议合入后自动 `previewLayout()`（当前由用户手动触发）。
5. **分页符叠加交互**：`PageBreakOverlay` 现仅展示；Wave4 加右键「在此插入分页符」、拖动已有符、选中删除（调 `aiApi.addManualPageBreak/removePageBreak`）。

## 6. 测试与截图

- core：94 通过（81 旧 + 13 新：schema 合法/臆造 id/缺 reason/坏 JSON、apply 每类语义+幂等、prompt 含全部 id/边、gap-detect 空叶子/游离、flow 手动符切页、bbox 过滤、tiles 手动符增页）。
- web：88 通过（75 旧 + 13 新：tiptap→md 各块型快照、SVG 含节点文本+`#arrow` marker+续接圆圈、extractJson 围栏/噪音、provider 成功/HTTP 失败/缺配置/非 JSON）。
- 截图存 `/tmp/p1-j-shots/`（AI 设置、diff 清单、分页符叠加、SVG/MD 导出结果）。
