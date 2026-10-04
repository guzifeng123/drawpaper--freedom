# Wave1-A · core model / graph / serialize 实现说明

> 范围：`packages/core/src/model/`、`packages/core/src/graph/`、`packages/core/src/serialize/`。
> 纯逻辑、零 DOM/React 依赖，全部带 vitest 单测。本文件记录最终公开 API、与 Wave0 冻结契约的差异、以及默认值常量。

## 0. 与冻结契约（ARCHITECTURE §2/§4）的差异

原则上保持签名稳定；下列为实现中必须做的调整，均限于本 wave 拥有的文件内：

1. **`validateGraph` 签名变更**：由骨架的 `validateGraph(doc: KBNoteDoc): GraphValidationResult`
   改为 `validateGraph(nodes: BlockNode[], edges: Edge[]): ValidationIssue[]`。
   原因：`parentid-mismatch` 需要逐节点对比 `node.parentId` 与 edges 推导值，入参需直接拿 nodes+edges。
2. **`ValidationIssue` 改为可辨识联合**：原骨架为 `{ kind: ValidationIssueKind; nodeIds?; edgeIds?; message? }`
   的宽松结构；现改为以 `code` 为判别字段的 6 路可辨识联合（见 §2），每种 issue 携带精确负载。
   同时**移除** `ValidationIssueKind` 与 `GraphValidationResult`（无其他模块引用）。
3. **`safeParseKBNoteDoc` 返回形状**：由 `z.SafeParseReturnType` 改为判别联合
   `{ success:true; doc } | { success:false; error: KBNoteParseError }`。
4. **新增 `KBNoteParseError`**（schema.ts）：包装 zod 错误，暴露 `issues: {path,message}[]`（dotted path）。
5. **`MainTreeDecision.keepParentEdgeId: string` → `keepParentEdgeIds: string[]`**：
   一个文档可同时有多个多父节点，建议主父边需逐条给出（按 `multiParents` 顺序）。
6. **`MIGRATION_REGISTRY` 值类型**：`(doc: Record<string,unknown>)=>Record<string,unknown>` →
   `(raw: unknown) => unknown`（更宽松，与任务约定一致）。
7. serialize 新增类型化错误 `KBNoteFileError`（kind: `invalid-json | wrong-format | unsupported-version | schema`）
   与公开函数 `migrate(raw, fromVersion): { value, notes }`。

## 1. 公开 API 清单

### model/（数据模型 + zod 校验 + 工厂）

类型（冻结，未改）：`KBNoteDoc` `BlockNode` `Edge` `Tag` `LayoutPrefs` `Viewport` `PageSettings`
`BlockType` `HandlePosition` `BlockStyle` `BlockContent` `BoardMeta`。

常量（edge-colors.ts 未动）：`EDGE_COLORS` `DEFAULT_EDGE_COLOR` `ALL_EDGE_COLORS` `DOC_FORMAT`
`CURRENT_DOC_VERSION` `P0_BLOCK_TYPES` `P0_LAYOUT_MODES`。

运行时校验（schema.ts）：
```ts
class KBNoteParseError extends Error { issues: { path: string; message: string }[] }
type SafeParseKBNoteResult = { success: true; doc: KBNoteDoc }
                           | { success: false; error: KBNoteParseError };
function parseKBNoteDoc(input: unknown): KBNoteDoc;                 // 失败抛 KBNoteParseError
function safeParseKBNoteDoc(input: unknown): SafeParseKBNoteResult;
function validateGraph(nodes: BlockNode[], edges: Edge[]): ValidationIssue[];
```

工厂（factory.ts，新增）：
```ts
const ID_PREFIX = { doc: 'doc_', node: 'n_', edge: 'e_', tag: 't_' };
const EMPTY_TIPTAP_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };
const DEFAULT_NODE_SIZES: Record<BlockType, { width: number; height: number }>;
function createDoc(title?: string): KBNoteDoc;
function createNode(type: BlockType, x: number, y: number, partial?: NodeOverrides): BlockNode;
function createEdge(source: string, target: string, partial?: EdgeOverrides): Edge;
function createTag(name: string, color: string): Tag;
```

### graph/（图分析纯函数）

```ts
interface TreeNode  { nodeId; parentId: string|null; children: string[]; depth: number }
interface MainTree  { roots: string[]; nodes: Record<string, TreeNode> }
interface MultiParentIssue { nodeId; parentEdgeIds: string[]; parentIds: string[] }
interface CycleIssue { nodeIds: string[]; edgeIds: string[] }
interface GraphAnalysis {
  tree: MainTree; multiParents: MultiParentIssue[]; cycles: CycleIssue[];
  danglingEdges: string[]; orphanNodes: string[];
}
interface MainTreeDecision {
  keepParentEdgeIds: string[]; dropEdgeIds: string[]; breakCycleEdgeIds: string[];
}

function buildMainTree(nodes, edges): MainTree;
function enumerateSubtree(tree: MainTree, rootId: string): string[];
function connectedComponents(nodes, edges): string[][];
function findOrphans(nodes, edges): string[];
function detectConflicts(nodes, edges): Pick<GraphAnalysis,'multiParents'|'cycles'>;
function analyzeGraph(nodes, edges): GraphAnalysis;
function suggestMainTreeDecision(analysis: GraphAnalysis): MainTreeDecision;
```

### serialize/（.kbnote）

```ts
const currentVersion = CURRENT_DOC_VERSION;            // = 1
const MIGRATION_REGISTRY: Record<number, (raw: unknown) => unknown>;
type MigrationStep = (raw: unknown) => unknown;
interface ParseKBNoteResult { doc: KBNoteDoc; migrationNotes: string[] }
class KBNoteFileError extends Error { kind: 'invalid-json'|'wrong-format'|'unsupported-version'|'schema' }

function serializeKBNote(doc: KBNoteDoc): string;       // 2 空格，format/version 在前
function parseKBNote(json: string): ParseKBNoteResult;   // 非法 JSON/格式/高版本抛 KBNoteFileError
function migrate(raw: unknown, fromVersion: number): { value: unknown; notes: string[] };
```

## 2. ValidationIssue 完整负载结构（可辨识联合）

```ts
type ValidationIssue =
  | { code: 'self-loop';
      edgeId: string; nodeId: string }
  | { code: 'dangling-edge';
      edgeId: string; endpoint: 'source' | 'target'; missingNodeId: string }
  | { code: 'duplicate-edge';
      edgeId: string; firstEdgeId: string; source: string; target: string }
  | { code: 'multi-parent';
      nodeId: string; parentEdgeIds: string[]; parentIds: string[] }
  | { code: 'cycle';
      nodeIds: string[]; edgeIds: string[] }              // nodeIds 首尾闭合；edgeIds 断任一即破环
  | { code: 'parentid-mismatch';
      nodeId: string; declaredParentId: string | null; derivedParentId: string | null };
```

语义约定：
- `self-loop`：source === target（同时也计入 `cycle`）。
- `dangling-edge`：source 或 target 指向不存在节点，按缺失端点各报一条。
- `duplicate-edge`：同一 `source→target` 第二次起报，`firstEdgeId` 为首次出现的边。
- `multi-parent`：端点存在且非自环的入度 > 1，`parentEdgeIds`/`parentIds` 按 edges 数组顺序对齐。
- `cycle`：DFS 着色（白/灰/黑）发现的有向环，自环算环；按环边集合去重。
- `parentid-mismatch`：节点声明的 `parentId` 与「首条有效入边推导父」不一致。

## 3. 默认值常量表

| 位置 | 字段 | 默认值 |
|---|---|---|
| 节点 | pinned / locked / collapsed | `false` |
| 节点 | tags | `[]` |
| 节点 | parentId | `null` |
| 节点 | style | `{}` |
| 节点 | content | `{ format:'tiptap-json', data: EMPTY_TIPTAP_DOC }` |
| 边 | directed | `true` |
| 边 | sourceHandle / targetHandle | `'right'` / `'left'` |
| 边 | label | `''` |
| 边 | style.color | `DEFAULT_EDGE_COLOR.hex` = `#94A3B8` |
| 文档 | title | `'未命名画布'` |
| 文档 | board | `{ createdAt:0, updatedAt:0 }`（factory 用 `Date.now()`） |
| 文档 | layout | `{ mode:'mindmap-right', rankSpacing:90, nodeSpacing:28 }` |
| 文档 | viewport | `{ x:0, y:0, zoom:1 }` |
| 文档 | page | `A4 / portrait / marginMm 15 / fit / showPageBreak true / colorMode color / header footer showPageNumbers false / pageBreaks []` |
| 文档 | assetRefs | `[]` |

新建块默认尺寸（`DEFAULT_NODE_SIZES`）：

| type | w×h |
|---|---|
| text | 260×80 |
| heading | 260×48 |
| todo / bullet | 260×60 |
| image | 240×180 |
| note | 240×160 |
| group | 320×200 |
| P1 预留（table/code/equation/bookmark/attachment/reminder） | 260×80 |

## 4. 关键算法约定（确定性）

- **buildMainTree**：按 edges 数组顺序，target 的第一条「合法入边」（非自环、端点存在、目标尚无父、
  且沿 parent 指针向上不会回到 target）成为主父。森林可多根；depth 从 roots BFS 计算（带 visited 防环）。
- **多父裁决建议**：每个 multiParent 保留首条入边进 `keepParentEdgeIds`，其余进 `dropEdgeIds`。
- **成环裁决建议**：每个环断开 `edgeIds` 中最后一条进 `breakCycleEdgeIds`。
- **连通分量**：并查集忽略方向；孤立点自成单元素分量。
- **迁移**：`migrate(raw, fromVersion)` 按 `MIGRATION_REGISTRY[fromVersion]` 逐级升到 currentVersion；
  fromVersion === current 恒等。当前 currentVersion=1，注册表为空（结构为未来就绪）。
