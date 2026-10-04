import type { BlockNode, Edge, KBNoteDoc, Viewport, BlockType } from '../model/index.js';

/**
 * EditorStore：全局编辑状态 + 全部 action 签名契约。
 * 实现：zustand + immer + Command 栈（Wave1-C）。此处只冻结「状态形状 + 动作签名 + JSDoc 语义」。
 */

/** 交互模式（工具状态机）。 */
export type InteractionMode =
  | 'select' // 默认选择
  | 'connect' // 连线
  | 'pan' // 平移
  | 'box-select' // 框选
  | 'insert'; // 新建块

/** 保存状态（自动保存提示用）。 */
export type SaveState = 'idle' | 'saving' | 'saved';

/**
 * 多父/成环冲突的用户裁决结果（由 UI 弹窗异步收集后回传）。
 * 多父：选唯一主父 edgeId，其余父子边经可撤销 Command 删除；
 * 成环：选一条边断开。不存在「降级为虚线回链」。
 */
export interface ConflictResolution {
  /** 多父：每个冲突节点选一条保留为主父的 edgeId。 */
  choosePrimaryParent: Record<string, string>;
  /** 成环：要断开的边 id。 */
  breakEdgeIds: string[];
}

/** 搜索索引句柄（MiniSearch 实例由 web 侧持有，core 只存不透明句柄）。 */
export type SearchIndexHandle = unknown;

/** Store 状态形状。 */
export interface EditorState {
  /** 当前打开的文档。 */
  doc: KBNoteDoc;

  /** 选中的节点 id 集合。 */
  selection: Set<string>;
  /** 当前正在编辑（块内 Tiptap）的节点 id。 */
  editingNodeId: string | null;
  /** 当前交互模式。 */
  mode: InteractionMode;
  /** 画布视口。 */
  viewport: Viewport;

  /** 保存状态与时间戳。 */
  saveState: SaveState;
  savedAt: number | null;

  /** 搜索索引句柄。 */
  searchIndex: SearchIndexHandle;
  /** 搜索结果高亮的节点 id。 */
  searchHighlight: Set<string>;
}

/**
 * 全部 action 签名。实现留 Wave1-C。
 * 约定：所有写操作内部走 Command（可撤销）；content 更新走 coalesceKey 防抖合并。
 */
export interface EditorActions {
  // ---- 文档级 ----
  /** 新建空白文档（替换当前 doc）。 */
  newDoc(): void;
  /** 重命名当前文档。 */
  renameDoc(title: string): void;
  /** 以导入的文档替换当前。 */
  loadDoc(doc: KBNoteDoc): void;

  // ---- 节点 CRUD ----
  /** 新建块（type + 位置），返回新块 id。 */
  addNode(type: BlockType, x: number, y: number): string;
  /** 批量新建块。 */
  addNodes(nodes: BlockNode[]): void;
  /** 删除块（连同其出入边）。 */
  deleteNode(id: string): void;
  /** 删除多个块。 */
  deleteNodes(ids: string[]): void;
  /** 更新块内富文本 content（防抖合并）。 */
  updateContent(id: string, data: unknown): void;
  /** 移动块。 */
  moveNode(id: string, x: number, y: number): void;
  /** 调整块尺寸。 */
  resizeNode(id: string, width: number, height: number): void;

  // ---- 边（父子）----
  /** 新增父子边；若产生多父/成环，挂起冲突等待 resolveConflicts。 */
  addEdge(source: string, target: string, opts?: { label?: string; sourceHandle?: Edge['sourceHandle']; targetHandle?: Edge['targetHandle'] }): void;
  /** 删除边。 */
  deleteEdge(id: string): void;

  // ---- 导图键盘建块 ----
  /** Tab：在选中块下新建子块并连父子边。 */
  tabAddChild(): void;
  /** Enter：在同级新建兄弟块。 */
  enterAddSibling(): void;
  /** Shift+Tab：把当前块升级（脱离当前父，挂到祖父）。 */
  shiftTabDemote(): void;

  // ---- 布局（宏命令，可撤销）----
  /** 一键整理：预览→应用→250ms 落位，整体作为一条可撤销宏。 */
  applyLayout(): void;

  // ---- 块属性 ----
  /** 置顶/取消置顶（pinned）。 */
  togglePin(id: string): void;
  /** 折叠/展开子分支。 */
  toggleCollapse(id: string): void;
  /** todo 块勾选。 */
  toggleTodo(id: string): void;

  // ---- 标签 ----
  addTagToNode(nodeId: string, tagId: string): void;
  removeTagFromNode(nodeId: string, tagId: string): void;

  // ---- 选择 / 模式 ----
  setSelection(ids: string[]): void;
  setMode(mode: InteractionMode): void;
  setEditingNode(id: string | null): void;
  setViewport(vp: Viewport): void;

  // ---- 剪贴板 ----
  copy(): void;
  cut(): void;
  paste(): void;
  duplicate(): void;

  // ---- 撤销重做 ----
  undo(): void;
  redo(): void;

  // ---- 冲突裁决 ----
  /** UI 弹窗收集完用户裁决后回传，store 据此落定主父、删除多余边、断环。 */
  resolveConflicts(resolution: ConflictResolution): void;

  // ---- 保存状态 ----
  setSaveState(s: SaveState): void;
}

/** 组合后的 store：state + actions。 */
export type EditorStore = EditorState & EditorActions;

/**
 * 创建 editor store（zustand）。
 * 【TODO wave1-c】
 */
export function createEditorStore(_init: KBNoteDoc): EditorStore {
  throw new Error('not implemented: wave1-c (createEditorStore)');
}
