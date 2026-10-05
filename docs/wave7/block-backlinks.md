# Wave7 P2.1 · 删除块时的跨文档反链影响确认 + 重命名追踪

> 分支 `feat/p21-block-backlinks`（基于 develop 9d16fd4）。
> 在 Wave6b 跨文档双向链接（docRef mark / links 索引 / 反链面板 / 删文档影响确认）之上，
> 补齐「删块」这一原先无确认弹层的路径。

---

## 1. 需求与落地概览

| 需求 | 落地 |
|---|---|
| 删块前影响确认（incoming/outgoing 分组、视觉对齐删文档 ConfirmDialog） | `wiring/block-delete-guard.ts` + `panels/BlockDeleteConfirmDialog.tsx` |
| 「保留为悬挂链接」 | 只删块；incoming links 记录保留 → `findDanglingLinks` 判 node-missing → chip `.is-dangling` |
| 「一并移除这些链接」 | 同文档 mark 清理走可撤销 macro；跨文档源 mark 走存储层级联 + 快照 |
| 无影响删除不弹框 | impact=0 时直接 `store.deleteNodes`，保持现状 |
| 可撤销语义 | 当前文档全部变更 = 一个 macro；跨文档级联写前对每个被改文档拍快照 |
| 重命名追踪 | 保存后对账：`syncBacklinkTitles` 跨文档批量回写 + 内存命令刷新自引用 |
| core 纯函数 + 单测 | `links/links.ts` 新增 `stripDocRefMarks` / `retitleDocRefMarks` / `linksAffectedByDeleteNodes` |
| e2e | `e2e/p21-block-backlinks.spec.ts`（4 例，E2E_PORT=4181） |

## 2. core 纯函数（packages/core/src/links/links.ts，零 DOM）

- `linksAffectedByDeleteNodes(docId, nodeIds: ReadonlySet, links)` — 批量删除影响聚合：
  出链 = 源在被删集合内；入链 = 目标在被删集合内。`linksAffectedByDeleteNode` 改为其单节点包装。
- `stripDocRefMarks(doc, removeLinkIds: ReadonlySet) → { doc, count }` — 级联移除变换：
  遍历每块 Tiptap JSON，对每个 docRef mark 按四元组重算稳定 link id，命中待删集合则摘除该 mark
  （保留文本，`[[...]]` 退化为纯文本不吞字）。links 索引由调用方用 `extractDocLinks` 重建。
- `retitleDocRefMarks(doc, targetDocId, targetNodeId, newTitle) → { doc, count }` — 重命名重索引：
  命中目标键的 mark，`attrs.targetTitle` 恒刷新；可见文本中 `[[旧标题]]` 子串替换为 `[[新标题]]`
  （兼容「看 [[旧]]」这类 mark 覆盖整段的情形；用户改过的自定义文本按子串口径安全替换）。
- 结构共享：无改动的子树/节点共享原引用。

## 3. store（packages/core/src/store/store.ts）

- `deleteNodesWithLinkCleanup(ids, stripLinkIds)` — 一个 `runMacro('delete-nodes-with-link-cleanup')`：
  ① `strip-incoming-docref-marks`（core 纯函数摘同文档 incoming mark）→ ② `delete-nodes`。
  两步同进同退，undo 一次回退。
- `retitleSelfMarks(targetNodeId, newTitle)` — 当前文档自引用 mark 的可撤销回写命令。
- 跨文档（其他 Dexie 文档里的源 mark）不在当前 undo 栈内，走存储层（见 §4）。

## 4. web 存储层级联写路径（packages/web/src/storage/link-writes.ts）

统一写入路径：`load → core 纯函数变换 → extractDocLinks 重建 links → saveDoc`。
**每次直写前对被改文档拍快照**（`storageAdapter.saveSnapshot(docId, label, serializeKBNote(原doc))`，
复用 snapshots 表现有机制，每文档保留最近 20 条）——跨文档级联可经快照恢复。

- `cascadeRemoveLinksAcrossDocs(removeLinkIds, exceptDocId)` — 「一并移除」时剥掉其他文档的源 mark。
- `retitleAcrossDocs(targetDocId, targetNodeId, newTitle, exceptDocId?)` — 重命名批量回写。
- `syncBacklinkTitles(currentDoc)` — 保存后对账：扫全量 Dexie 文档，找 targetDocId=当前文档
  且 link.targetTitle 与块当前纯文本首行不符的记录（即目标块被改名），级联回写；返回重命名表，
  App 对当前文档内存态走 `retitleSelfMarks` 命令（可撤销、当帧刷新 chip）。

## 5. web UI 与接线

- `wiring/block-delete-guard.ts` — `requestDeleteNodes(store, ids)`：实时重建当前文档 links +
  合并 Dexie links → `linksAffectedByDeleteNodes`。impact=0 直删；>0 写入 `useWiringUi.blockDeleteRequest`
  弹出确认框。`resolveBlockDeleteRequest(store, 'keep'|'remove')` 处理两个动作。
- `wiring/create-editor-api.ts` — `deleteNodes` 改为 `void requestDeleteNodes(store, ids)`，
  键盘 Delete/Backspace 与 hover 工具条删除都走同一守卫。
- `panels/BlockDeleteConfirmDialog.tsx` — 复用 Dialog primitives，视觉与删文档 ConfirmDialog 一致；
  incoming 分组（《来源文档》块「摘要」）+ outgoing 分组 + 两个动作按钮 + 取消。
- `App.tsx` — 渲染确认框；`saveState==='saved'` 后跑 `syncBacklinkTitles`（按 doc 引用去重，不重复对账）。
- dev-hooks：新增 `deleteBlocksGuarded(ids)`（e2e 入口，与键盘/工具条同一函数）；白名单补 `updateContent`。

## 6. 跨文档撤销语义说明（如实）

- 当前文档内的全部变更（删块 + 同文档 mark 清理）= 一个可撤销 macro，Ctrl+Z 一次回退。
- 跨文档级联移除（其他 Dexie 文档里的源 mark）**不在 undo 栈**：操作前对每个被改文档写一条快照
  （label「删除块前·移除引用」/「重命名目标·同步引用」），用户可经快照面板整份恢复被改文档。
- 「保留为悬挂链接」不写任何快照：incoming links 记录保留，目标块缺失后 chip 自然呈现红虚边，
  原块若后续经 undo 恢复，悬挂态也自动消退。禁止静默丢链：任何级联移除都先快照。

## 7. 证据

- core 单测 172（基线 165 + 新增 7：批量影响 1、级联移除 3、重命名重索引 3）。
- web 单测 199（基线 199，只增不减）。
- e2e `p21-block-backlinks.spec.ts` 4 例全绿（端口 4181）；`cross-doc-links.spec.ts` 不回退。
- 门禁 `pnpm -r build` / `pnpm typecheck` / `pnpm lint` 0 error。

## 8. 遗留

- 重命名对账触发点是「保存成功后」，即首次 chip 刷新在保存后当帧（内存自引用）/ 重开后（跨文档）；
  编辑中途（未落盘）不做实时级联。
- 级联移除只摘 docRef mark、保留 `[[...]]` 文本（退化为纯文本），不自动删字。
- 跨文档级联不可 Ctrl+Z，仅可经快照恢复——已在确认框文案中如实说明。
