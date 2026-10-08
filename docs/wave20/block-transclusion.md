# Wave20 V 路：跨画布只读「块嵌入」（block transclusion）

状态：feat/block-transclusion（基线 origin/develop=060fda1）。
定位：P3 知识网络最后一块——双链 / 反链 / 全局总览已上线，本路补上**跨画布只读嵌入**。

---

## 1. 数据契约（附加式，**不升 schema 版本**，仍 v4）

### 1.1 为什么不动 schema 版本

`BlockContentSchema.data` 在 core 校验里是 `z.unknown()`（`packages/core/src/model/schema.ts`），
任意形状透传；节点 `type` 枚举是**封闭枚举**——若新增 `'doc-embed'` 节点类型，
旧 v4 读取方的 zod 枚举会整体拒掉整份文档（safeParse 失败 → 文档打不开）。
因此本路**复用既有常规节点类型 `note` 作 host**，嵌入 payload 挂在 `content.data` 上：

```jsonc
// 节点：type='note'（旧 v4 完全认识）
"content": {
  "format": "tiptap-json",
  "data": {
    "kind": "doc-embed",
    "targetDocId": "doc_A",
    "targetNodeId": "n_A1",
    "titleSnapshot": "目标块代表标题"
  }
}
```

- 旧 v4 读取方：解析通过（type=note 认识、data 透传），UI 退化为普通便签渲染原始 JSON——
  **优雅降级、不炸档**。契约测试 `schema.test.ts`「v4 schema 宽容承载 doc-embed payload」锁定此行为。
- 与 P1 特殊块（equation/bookmark/attachment/reminder）同一「content.data.kind」模式。
- core 侧纯模块：`packages/core/src/model/doc-embed.ts`（类型 + `parseDocEmbedData` 宽容解析：
  未知 kind / 畸形 payload → null，不抛）。**core 零 DOM/React**。
- **本地-first：只存引用，不复制对方正文**（标题快照除外）。`.kbnote` 序列化只带四元组引用。

### 1.2 titleSnapshot

创建时目标块的代表标题（`doc-ref-search.nodeDisplayTitle`）。目标块改名后，
既有 link-writes 对账（`syncBacklinkTitles` → `retitleAcrossDocs`）会经扩展后的
`retitleDocRefMarks` 同步刷新嵌入 payload 里的 `titleSnapshot`——与行内 docRef mark 同口径。

---

## 2. 与双链 / 反链 / 总览的关系（全部复用，不造第二套）

嵌入即一条**出链**：`extractDocLinks`（core）除遍历 Tiptap 正文 docRef mark 外，
额外扫描每块 `content.data`——命中 `doc-embed` payload 即产出一条 DocRefLink：

- 链接 id 由四元组 `(sourceDoc, sourceNode, targetDoc, targetNode)` 派生（`deriveLinkId`），
  与行内 mark 同口径 → 反链索引、悬挂判定、删除维护全部零改动复用；
- 嵌入块被删 → 节点消失 → flushSave 重建 links 自动清引用，**无悬挂反链残留**；
- A 画布块被 B 嵌入 → A 的 BacklinksPanel（文档级/块级）经 `buildBacklinkIndex` 列出 B；
- 目标块/文档被删 → `findDanglingLinks` 判 `node-missing` / `doc-missing`，
  链接记录保留（与行内双链同策略，不静默丢）。

---

## 3. 渲染与生命周期（web）

`editor/nodes/DocEmbedBlock.tsx`（host 在 NoteBlock 内按 `kind==='doc-embed'` 分派）：

- **只读**：复用 BlockShell 外壳但禁用 Tiptap 编辑（renderEditor 只给只读说明）；
  正文用 `StaticHtml`（Tiptap 静态管线）渲染目标块 `content.data`。
- **头部**：嵌入图标 + 来源画布标题（挂载时从 Dexie 实时解析目标 doc 标题；
  悬挂时回退 titleSnapshot）+ 手动刷新按钮（`data-embed-source`）。
- **点击主体** → `EditorApi.openDocRef`（与 panels openDocRef 同口径：
  文档内 flyTo / 跨文档 openDoc+聚焦），`data-embed-target`。
- **生命周期**：组件挂载（打开文档 / 切换画布 / 手动刷新）即 `db.docs.get(targetDocId)`
  解析最新内容——目标改了即见新版；不做双向实时同步。
- **图片**：目标块含图片时经 `useResolvedImageSrc` 解析 OPFS 资产
  （OPFS 同源全局，跨文档直接可用）；解析失败显示「含图片的嵌入」虚线占位，不裂图不报错。
- **悬挂**：目标块/文档缺失 → 虚线占位 `.doc-embed--dangling` + 「原块已删除 / 不可用」
  + 标题快照（`data-embed-dangling`），复用 docRef 悬挂的视觉语言，独立 class。

### 插入入口

斜杠菜单新增「嵌入其他画布的块」（`slash-menu.tsx` → `{kind:'embed-pick'}`）：
退出编辑态 → `DocEmbedPicker` 弹出（复用 `storage/doc-ref-search.searchDocRefTargets`，
与 `[[双链]]` 同一目标选择器）→ 选定后 `setBlockType('note') + updateContent(embed payload)`。
v1 不做 `{{` 触发。

---

## 4. 导出行为

| 路径 | 行为 |
| --- | --- |
| 打印 / PNG（PrintSheets） | 嵌入节点渲染来源标题 caption（蓝色斜体）+ 目标正文 TiptapStatic；目标已删 → 悬挂占位 |
| 矢量 PDF / SVG（svg-export `buildPagesSvgAsync`） | 预解析全量文档得 `embedInfo`：`嵌入自「画布名」` caption + 目标正文行；悬挂 → 占位行 |
| Markdown（markdown-export） | 引用块：`> 嵌入自「画布名」` + `> [[标题快照]]`；**不复制对方正文**；画布名由导出管线从 Dexie 注入 `docTitles` |
| `.kbnote` 序列化 | 只带引用四元组，无正文副本 |

---

## 5. 测试硬验收

- core：`model/doc-embed.test.ts`（宽容解析/未知 kind/畸形 payload）；
  `links/links.test.ts` 追加嵌入收录 / 删块清引用 / 反链索引 / 悬挂判定 / retitle 回写；
  `model/schema.test.ts` 追加 v4 宽容承载（无迁移）。
- web：`export/markdown-export.test.ts`（嵌入引用块 + 回归）。
- e2e：`e2e/wave20-block-transclusion.spec.ts`——①B 可见 A 正文；②改 A 重开 B 见新版；
  ③删 A 目标块 → 悬挂占位；④SVG 导出含正文+来源标题；⑤反链列出 B；
  ⑥reload 持久化 + 序列化无正文副本；⑦纯浏览器路径。

---

## 6. 红线自检

- core 零 DOM/React；嵌入渲染在 web。✅
- 边只有父子一种；未碰边色常量。✅
- 零新依赖、零外网、零网络库/zip 库；未碰 updater / workflow / Android。✅
- 附加式：host 复用既有 `note` type，未升 schema 版本（v4→**v4**，无迁移单测需求）。✅
- 本地-first：payload 仅四元组引用 + 标题快照，无正文副本。✅
