# Wave6b · 跨画布双向链接（cross-doc-links）

> 范围：core 新增 `links/` 纯函数模块；web 的 tiptap docRef mark、[[ 提及浮层、跨文档查询、BacklinksPanel、store 保存链路重建。
> 冻结契约见 `docs/wave6/schema-migration.md`（DocRefLink / docRef mark）。本文件供 Wave7 总装接线。

## 1. core 新增导出（`packages/core/src/links/`）

纯函数、零 DOM、零 tiptap 依赖（仅遍历 Tiptap JSON 树）。

| 函数 | 签名 | 说明 |
|---|---|---|
| `deriveLinkId` | `(sDoc,sNode,tDoc,tNode) => string` | 四元组 FNV-1a 短哈希 → `ln_` 前缀稳定 id（重建不 churn） |
| `extractDocLinks` | `(docId, nodes, {existingLinks?, now?}) => DocRefLink[]` | 扫描块正文 docRef mark → 规范化链接；命中旧 id 保留 createdAt；重复目标刷新 title |
| `buildBacklinkIndex` | `(docs[]) => Map<"tDoc::tNode", DocRefLink[]>` | 跨文档反链索引 |
| `backlinkKey` | `(docId,nodeId) => string` | 索引键 |
| `findDanglingLinks` | `(links, docs[]) => {link, reason:"doc-missing"\|"node-missing"}[]` | 区分目标文档缺失 / 目标块缺失 |
| `linksAffectedByDeleteDoc` | `(docId, links) => {outgoing, incoming}` | 删文档前影响分析 |
| `linksAffectedByDeleteNode` | `(docId,nodeId, links) => {outgoing, incoming}` | 删块前影响分析 |

## 2. 保存链路接线（core store）

`flushSave` 在 `storage.saveDoc` / FSA 写盘前：
```ts
const links = extractDocLinks(cur.id, cur.nodes, { existingLinks: cur.links ?? [], now });
const doc = sameIds ? cur : { ...cur, links };
```
- 无 docRef mark 时结果恒为 `[]`，与既有 fixture 不冲突（140 core 测试不回归）。
- 序列化/导出用重建后的 doc，links 随 .kbnote 持久化。
- v2 文档若打开时 marks 与索引不一致，下次自动保存即懒重建（dirty 由编辑触发）。

## 3. web 实现

- **docRef mark**（`editor/tiptap/doc-ref-mark.ts`）：Tiptap Mark，name `docRef`，attrs `{targetDocId,targetNodeId,targetTitle}`，渲染 `<span class="drawpaper-docref">[[标题]]</span>`。已注册进 `createBlockEditor` 与静态渲染扩展。chip 样式：浅紫底圆角；悬挂态 `.is-dangling` 红虚边（CSS 已就位，渲染期悬挂判定由 Wave7 接入）。
- **[[ 提及浮层**（`editor/tiptap/doc-ref-mention.tsx`）：块内输入 `[[`（可继续输查询）唤起，150ms 防抖异步查 Dexie；方向键/鼠标/Esc 选择；插入 `[[目标标题]]` 并包 docRef mark。
- **跨文档查询**（`storage/doc-ref-search.ts`）：只读 Dexie `docs` 表，匹配文档标题/块标题/正文；`nodeDisplayTitle` 纯函数。
- **反链查询**（`storage/backlinks.ts`）：加载全部 docs → `buildBacklinkIndex` → 返回 `BacklinkEntry[]`（来源文档/块标题 + dangling 标记）。
- **BacklinksPanel**（`panels/BacklinksPanel.tsx`）：文档级 / 块级（`backlinksNodeId`）两维反链列表，点击 `openDocRef`。
- **接缝扩展**：`PanelsApi.openDocRef(targetDocId,targetNodeId)` + `backlinksNodeId/setBacklinksNodeId`；真实接线在 `create-panels-api.ts`（同文档 flyToNode，跨文档 openDoc→flyToNode）。

## 4. 悬挂处理

- 删除文档/块前可用 `linksAffectedByDelete*` 列出出链/入链（confirm 弹层由 Wave7 接真实删除流）。
- 删除后 chip 记录保留不丢（e2e 断言：删 docB 后 docA.currentLinks 仍为 1，targetDocId 仍在）。
- 重命名块/文档后 targetTitle 在下次索引重建刷新；反链面板标题取实时文档/块标题。

## 5. dev-hooks（e2e 断言）

`window.__drawpaper__` 新增：`currentLinks()`、`exportCurrent()`、`backlinksTo(docId,nodeId?)`。

## 6. 测试

- core：149（140 基线 + 9 links 纯函数：稳定 id、createdAt 保留、悬挂分类、影响分析）。
- web：178（基线，含 doc-ref-search 标题纯函数）。
- e2e：33（32 基线 + `cross-doc-links.spec.ts`：mark 重建 links、导出/导入持久化、反链可见、删除后链接不丢）。

## 7. 供 Wave7 的接缝清单

1. App 挂载 `BacklinksPanel`（当前未挂载，App.tsx 零改动）。
2. chip 点击真实跳转：`setDocRefClickHandler(openDocRef)` + `installDocRefClickDelegate()`（在 App 挂载期注册一次）。
3. 删除文档/块 confirm 弹层接 `linksAffectedByDelete*`。
4. chip 悬挂态：静态渲染时据 `findDanglingLinks` 补 `.is-dangling`。
5. BacklinksPanel 的块级维度与 `editingNodeId`/`focusNodeId` 联动。
