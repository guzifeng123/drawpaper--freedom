# Wave22 A：块内 `{{` 触发跨画布块嵌入

状态：feat/embed-brace-trigger（基线 rc.13=54ea5ce）。
定位：Wave20「块嵌入」v1 只做了斜杠菜单入口（见 `docs/wave20/block-transclusion.md` 末节
「v1 不做 `{{` 触发」），本路补上第二个、与 `[[双链]]` 同范式的正文触发入口。

---

## 1. 行为契约

块内连续输入 `{{`（两个左花括号）即弹出跨画布块选择浮层，与输入 `[[` 弹双链提及一致：

- 浮层**定位在光标处**（`coordsAtPos(from)`，零尺寸容器兜底 0,0）；
- 上下键移动选择、**Enter / Tab 确认**、**Esc 取消**、**点击浮层外部关闭**；
- 继续输入按查询词过滤目标块——复用 `storage/doc-ref-search.searchDocRefTargets`
  （与斜杠路径的 `DocEmbedPicker`、`[[双链]]` 同一查询，120ms 防抖，空库不崩、显示「无匹配块」）。

### 插入路径：完全复用斜杠「嵌入其他画布的块」

选定目标后**不新造数据结构**——走 `BlockShell` 里斜杠路径同一条写入：

```ts
setBlockType(block.id, 'note');
updateContent(block.id, { kind:'doc-embed', targetDocId, targetNodeId, titleSnapshot });
setEditingNode(null); // {{ 路径在选定后退出编辑态（斜杠路径在弹 picker 前已退）
```

`{{query` 触发文本在选定前由组件内部先从正文删除（与 `[[` 删除 `[[query` 同构）。

---

## 2. 边界

| 边界 | 处理 |
| --- | --- |
| 代码块内 | `parent.type.name === 'codeBlock'` → 不触发（`isInCodeContext`） |
| 行内 code mark | `$head.marks()` 含 `code` → 不触发（同一守卫） |
| 空库 | `searchDocRefTargets` 自带 try/catch 兜底，候选为空 → 弹层显示「无匹配块」 |
| IME 组合期 | window `compositionstart/end` 标记：组合期间 Enter/Tab/方向键全部让路给输入法候选窗，不误选；组合结束后恢复 |
| 自引用 | 触发器把正在编辑的块 id（`excludeNodeId`）从候选里剔除——块正文就是查询词，否则会与目标同分排在首位误选中自己 |

### 与 `[[双链]]` 的一致性

`isInCodeContext` 两个触发器共用。本次顺手给 `[[双链]]` 浮层补上了同一代码上下文守卫
（此前 `[[` 在代码块/行内代码内也会误弹浮层）——两个触发入口在代码上下文行为一致；
既有 cross-doc-links / p21-block-backlinks / wave20-block-transclusion e2e 均不涉及代码块内打
`[[`，零回归。

---

## 3. 改动面

- `packages/web/src/editor/tiptap/doc-embed-trigger.tsx`（新）：触发器组件 + 纯函数
  `matchEmbedTrigger` / `isInCodeContext`。
- `packages/web/src/editor/nodes/BlockShell.tsx`：挂载 `<DocEmbedTrigger>`；抽出
  `applyEmbedTarget` 与斜杠路径共用，新增 `onPickEmbedFromBrace`。
- `packages/web/src/editor/tiptap/doc-ref-mention.tsx`：接入 `isInCodeContext` 守卫。

**core 零改动**（`packages/core/` 未动）；**零新依赖**（pnpm-lock 零 diff）；**未碰 workflow**。

---

## 4. 测试

- web 单测 `editor/tiptap/doc-embed-trigger.test.tsx`（17 例）：触发匹配纯逻辑 /
  代码上下文守卫 / 弹出与候选 / 查询过滤 / Esc 取消 / Enter 确认并删触发文本 /
  IME 组合期让路 / 代码块不弹 / 空态不崩 / 自引用剔除。
- e2e `e2e/wave22-embed-trigger.spec.ts`：新画布建块 → 打 `{{` 并过滤 → Enter 选定 →
  块以 `data-embed-target` 嵌入形态渲染（头部来源=目标画布）→ 触发字符无残留 →
  reload 后仍在 → `backlinksTo` 见该引用。

## 5. 红线自检

- core 零改动、DOM/React 只在 web。✅
- 零新依赖、零外网、零网络库；未碰 updater / workflow / Android。✅
- 复用既有 payload 四元组，未升 schema、无迁移。✅
