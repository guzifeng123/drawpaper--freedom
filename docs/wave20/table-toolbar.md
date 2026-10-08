# Wave20 T 路：表格块工具栏 UI e2e 补齐

表格合并/拆分此前只有 `e2e/table-drag-merge.spec.ts` 一条「跨格拖选→合并→拆分」路径。
本次新增 `e2e/wave20-table-toolbar.spec.ts`，把表格块工具栏按钮、撤销重做、持久化、
Markdown 导出全部纳入 e2e 保护；过程中顺带修了两个真实产品 bug。

## 覆盖矩阵

| 用例 | 覆盖点 | 关键断言 |
| --- | --- | --- |
| (a) | 斜杠菜单 `/` 插入表格 → 进入编辑态 | 双击空白建文本块 → 输 `/` → 选「表格」→ 表格块出现，新建表格默认 2 行 2 列 |
| (b) | 工具条「加行（下方）」「加列（右侧）」 | `tr` 计数 2→3；首行单元格数 2→3（DOM `tr`/`th,td` 计数） |
| (c) | 「删行」「删列」 | 删行后 3→2 行，余格 A/E 仍在、C/D 消失；删列后每格 2→1 列，B/F 消失 |
| (d) | 「切换表头行」 | 默认 2 `th`+2 `td`；关闭表头 → 0 `th`+4 `td`；再开恢复 |
| (e) | 拖选后点「合并」按钮 / 「拆分」按钮 + disabled 态 | 单格光标下合并/拆分均 disabled；拖选两格后合并启用 → `colspan=2`；光标落合并格后拆分启用 → `colspan=2` 消失，拆分重新 disabled |
| (f) | 结构操作撤销/重做 | 加行后 `Ctrl+Z` 行数 3→2，`Ctrl+Y` 2→3 |
| (g) | 单元格打字后 reload 持久化 | 单元格文字落 OPFS，reload + fit 后文字与 2×2 结构仍在 |
| (h) | Markdown 导出含表 | 下载 `.md` 内含 `| 姓名 | 城市 |`、`| --- | --- |`、`张三`/`北京` |

选择器全部复用既有按钮可访问名（加行/加列/删行/删列/表头/合并/拆分/Markdown）与
DOM 计数，未为测试给产品 UI 加新 testid。

## 发现并修复的真实 bug

### bug 1：斜杠菜单/hover 工具条切到「表格」得到空段落块，没有表格网格

- **现象**：斜杠菜单选「表格」后，块类型变成 `table`、工具条（加行/合并…）都出现，
  但 ProseMirror 里只有一个空段落——没有任何 `<table>`，工具条按钮无从操作。
- **根因**：core `setBlockType(id, type)` 无条件把内容重置为通用空段落
  `EMPTY_TIPTAP_DOC`（`{type:'doc',content:[{type:'paragraph'}]}`），从不调用 web 侧的
  `defaultContentForType('table')`（2×2 网格）。web 侧 `create-editor-api` 又只是
  裸转发，于是切类型丢掉了类型专属空稿。`defaultContentForType` 此前只被
  `mock-editor-api`（测试）用到，生产路径从未走它。
- **修复**：
  - core `setBlockType(id, type, content?)` 增加可选第三参；传入时用它作新内容，
    缺省仍回退通用空段落（向后兼容）。`packages/core/src/store/store.ts`
  - web `create-editor-api.setBlockType` 转发时带上 `defaultContentForType(type)`，
    与 mock 行为对齐。`packages/web/src/wiring/create-editor-api.ts`

### bug 2：`emptyTableDoc()` 塞了空文本节点，ProseMirror 渲染直接抛错

- **现象**：修好 bug 1 后，斜杠建表真的产出表格网格，但 React 渲染崩溃
  `Empty text nodes are not allowed`，画布节点整个卸载（`react-flow__node` 数为 0）。
- **根因**：`content-defaults.emptyTableDoc()` 每个单元格段落写成
  `content:[{type:'text',text:''}]`——空字符串文本节点 ProseMirror schema 拒绝。
  此前生产从不调用这个函数（见 bug 1），所以问题被藏住；e2e 一打通就爆出来。
- **修复**：空段落改为 `{type:'paragraph',content:[]}`（段落无子节点），不再塞空 text。
  `packages/web/src/editor/content-defaults.ts`

### 顺带补齐：Markdown 导出不支持表格

- **缺口**：`tiptap-to-markdown.ts` 没有 `table/tableRow/tableHeader/tableCell` 分支，
  表格走 default 递归，单元格文字虽漏出但不成管道表格语法；`markdown-export` 又把
  块体首行当标题，表头行会被 `#` 吃掉、与分隔行断裂。
- **修复（最小）**：
  - `renderBlock` 新增 `table` 分支 → GFM 管道表格（首行表头 + `---` 分隔行 + 表体；
    `|` 转义；`colspan` 按列数展开）。`packages/web/src/export/render/tiptap-to-markdown.ts`
  - `markdown-export.visit` 对 `table` 类型整块直出，不再把首行当块标题。
    `packages/web/src/export/markdown-export.ts`
  - 补 vitest 两条（管道表格成行、竖线转义 + colspan 展开）。

## 门禁与运行

- 本地：`pnpm -r build`、`pnpm -r typecheck`、`npx eslint .`、
  `CI=true pnpm -r --filter "./packages/*" test`（core 319 / web 333，较基线 +2）。
- e2e：`cd packages/web && E2E_PORT=<p> npx playwright test wave20-table-toolbar`（8 全绿）；
  连跑 `table-drag-merge` 证明不回退（1 绿）。
- 红线：core 零 DOM（只多收一个 `BlockContent` 数据参数）；未引新依赖；零外网；
  未碰 Android / workflow / develop·main·tag·版本号·已发布 CHANGELOG 段。
