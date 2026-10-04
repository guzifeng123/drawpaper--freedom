# drawpaper 架构与模块契约（ARCHITECTURE）

> 本文是 Wave 0 冻结的**接口契约**。后续 5 个并行开发 agent 据此实现，**只改自己所有的目录**，不得越界改他人契约文件。
> 任何签名冲突以本文件 + `packages/core/src` 中的实际类型为准。

## 1. 分层

```
┌─────────────────────────────────────────────────────────────┐
│ 壳层 HostAdapter（可替换：Web PWA / 未来 Tauri / 平板）        │
│   打开/保存文件、打印、分享、原生菜单（不支持时降级上传/下载）  │
├─────────────────────────────────────────────────────────────┤
│ UI 层 packages/web（React 渲染与交互）                        │
│   React Flow 画布 · Tiptap 块编辑 · 工具栏/大纲/搜索/导出面板  │
├─────────────────────────────────────────────────────────────┤
│ 应用层 EditorStore（zustand + immer + Command 命令栈/撤销）   │
├─────────────────────────────────────────────────────────────┤
│ ★ core 包 packages/core（纯 TS，零 DOM/React/Vite 依赖）      │
│   model · graph · layout · paginate · serialize · store       │
├─────────────────────────────────────────────────────────────┤
│ 存储适配 StorageAdapter（Dexie/IndexedDB · OPFS · FS Access） │
└─────────────────────────────────────────────────────────────┘
```

### core 零 DOM 硬约束（验收线）

- `packages/core/tsconfig.json`：`"lib": ["ES2022"]`（**不含 DOM lib**），`strict` + `noUncheckedIndexedAccess`。
- ESLint `no-restricted-globals`：core 中出现 `window/document/HTMLElement/IndexedDB/fetch/Blob/console/...` 等即**报错**。
- `no-restricted-imports`：core 禁止 import `react` / `react-dom` / `@tiptap/*` / `vite`。
- 跨端二进制抽象：core 自定义 `BlobLike`（duck-type），不引用 DOM `Blob`。
- 平台能力一律由 web 注入：`StorageAdapter`（save/load/list/delete + Blob）、`HostAdapter`（open/save file picker、print、share）。

## 2. core 模块公开 API 契约表

> 签名详见各文件；下表为语义与所有权。占位实现统一 `throw new Error('not implemented: waveX')`。

| 模块 | 关键导出 | 语义 | 所有者 |
|---|---|---|---|
| `model/` | `KBNoteDoc` `BlockNode` `Edge` `Tag` `LayoutPrefs` `Viewport` `PageSettings` `EDGE_COLORS` `DEFAULT_EDGE_COLOR` `parseKBNoteDoc` `safeParseKBNoteDoc` `validateGraph` `ValidationIssue` | 数据模型类型 + zod 安全解析 + 图校验骨架（环/多父/悬空/自环/重复边） | **Wave1-A** |
| `graph/` | `buildMainTree` `enumerateSubtree` `connectedComponents` `findOrphans` `detectConflicts` `suggestMainTreeDecision` + `MainTree` `MultiParentIssue` `CycleIssue` `MainTreeDecision` | 由 edges 推导主树、子树枚举、连通分量、游离块、多父/成环检测与裁决建议 | **Wave1-A** |
| `serialize/` | `serializeKBNote(doc): string` `parseKBNote(json): {doc, migrationNotes}` `currentVersion=1` `MIGRATION_REGISTRY` | `.kbnote` 序列化 + 版本迁移管线 | **Wave1-A** |
| `layout/` | `layoutTree(input, mode): LayoutResult` + `MeasuredSize` `LayoutInput` `LayoutResult` `CollisionReport` | d3-hierarchy 树布局；P0 三模式 `mindmap-right/mindmap-down/org-tree`；`pinned` 绕行、`collapsed` 收子树 | **Wave1-B** |
| `paginate/` | `paginateFit` `paginateTiles` `paginateFlow` + `PageSheet` `ContinuationMarker` `OrphanWarning` + 物理常量 `mmToPx/A4_*` | A4 分页视图模型；tiles 含 10mm 重叠带 + 成对续接标记；flow 块零切割 | **Wave1-B** |
| `store/command.ts` | `Command` `CommandStack` `createCommandStack` | 可撤销命令对象 + undo/redo + 宏（`coalesceKey` 防抖合并） | **Wave1-C** |
| `store/store.ts` | `EditorStore` 状态 + 全部 action 签名；`ConflictResolution` `InteractionMode` `SaveState` | 当前文档/选择集/模式/视口/保存状态；节点 CRUD、content 防抖、move/resize、addEdge、Tab/Enter/Shift+Tab、applyLayout（宏）、pin/collapse/todo、剪贴板、undo/redo、resolveConflicts | **Wave1-C** |
| `store/adapters.ts` | `StorageAdapter` `HostAdapter` `AIProvider` `AISuggestion` `AIDiff` `applyAIDiff` `CollabAdapter` `BlobLike` | 平台注入接口；AI P1 接口先行；Yjs 仅空接口不装依赖 | **Wave1-C**（web 实现） |

### 冲突处理语义（多父 / 成环）

- 多父：一个节点有 >1 条入边 → UI 弹窗让用户选**唯一主父 edgeId**，其余父子边经可撤销 Command 删除。
- 成环：DFS 找到环 → UI 弹窗让用户选**断开哪条边**。
- **不存在**「降级为 relate 虚线」——边只有父子一种语义，冲突即删边/断边。

## 3. web 目录所有权表

| 目录 | 职责 | 所有者 |
|---|---|---|
| `src/editor/` | 自定义节点/边、画布交互状态机、快捷键、连线、块内 Tiptap 编辑 | **Wave1-D** |
| `src/panels/` | 工具栏 / 文档列表 / 搜索 / 导出弹窗 / 大纲等面板 | **Wave1-E** |
| `src/export/` | A4 分页叠加层、`window.print()`、pdf-lib + html-to-image 合成 | **Wave1-E** |
| `src/components/ui/` | shadcn/ui primitives（已生成 button 通路） | **Wave1-E** |
| `src/storage/` | `StorageAdapter` 的浏览器实现（Dexie/OPFS/FS Access） | **Wave1-C** |
| `src/host/` | `HostAdapter` 的 web 实现（file picker/print/share 降级） | **Wave1-C** |
| `src/store/` | 实例化 core store + React hooks 绑定、注入 adapter | **Wave1-C** |

> App 总装（把 editor/panels/export 挂进 `App.tsx`）在 **Wave 2**，Wave 1 各 agent 只做自己目录。

## 4. 数据模型（最终形态，冻结）

### Edge（**无 relation / line / direction 字段**）

```ts
interface Edge {
  id: string;
  source: string;            // 父
  target: string;            // 子
  sourceHandle: 'top'|'right'|'bottom'|'left';
  targetHandle: 'top'|'right'|'bottom'|'left';
  label: string;             // 自由文字标签
  directed: true;            // 恒 true
  style: { color: string };   // 取边色常量之一
}
```

### BlockNode

```ts
type BlockType = 'text'|'heading'|'todo'|'bullet'|'image'|'note'|'group'
  | 'table'|'code'|'equation'|'bookmark'|'attachment'|'reminder'; // 后 6 个 P1 预留
interface BlockNode {
  id: string; type: BlockType;
  x: number; y: number; width: number; height: number;
  content: { format: 'tiptap-json'; data: unknown };  // Tiptap doc 由 web 承载
  parentId: string | null;
  pinned: boolean; locked: boolean; collapsed: boolean;
  tags: string[]; style: { color?: string; bg?: string; border?: string };
  // 块特有可选字段：todo.checked / image.src / heading.level / bookmark.url ...
}
```

### KBNoteDoc

```ts
interface KBNoteDoc {
  format: 'knowledge-block-notes';
  version: 1;
  id: string; title: string;
  board: { createdAt: number; updatedAt: number };
  nodes: BlockNode[]; edges: Edge[]; tags: Tag[];
  layout: { mode: 'mindmap-right'|'mindmap-down'|'org-tree'|'radial'; rankSpacing: number; nodeSpacing: number };
  viewport: { x: number; y: number; zoom: number };
  page: PageSettings;        // A4 / orientation / marginMm 10|15|20 / mode fit|tiles|flow ...
  assetRefs: string[];       // OPFS Blob 引用
}
```

### 边色常量（样本色，日后可整体替换）

| key | 名称 | hex |
|---|---|---|
| blue | 淡蓝 | `#93C5FD` |
| green | 淡绿 | `#86EFAC` |
| yellow | 淡黄 | `#FCD34D` |
| purple | 淡紫 | `#D8B4FE` |
| pink | 淡粉 | `#F9A8D4` |
| neutral（DEFAULT_EDGE_COLOR） | 中性灰 | `#94A3B8` |

## 5. 分支 / 工作流约定

- 本脚手架在 `chore/monorepo-scaffold` 分支（从 main 切出）。
- 后续特性分支从 **develop**（由审查方在本脚手架完成后创建）切出，命名 `feat/<scope>-<kebab>`。
- 每个 agent **只改自己所有目录**；共享文件（根 tsconfig、eslint.config.js、core barrel）有改动必须在分支说明里列出并知会。
- 提交用 conventional commits（`feat:`/`fix:`/`docs:`/`chore:`）。
- 禁止动 main、禁止自建 develop、禁止把 dagre/d3-force/elkjs/yjs/tldraw/html2canvas/jsPDF 加进依赖。
