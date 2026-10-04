import { nanoid } from 'nanoid';
import { createStore } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import type { StoreApi } from 'zustand/vanilla';
import type {
  BlockNode,
  BlockStyle,
  BlockType,
  Edge,
  KBNoteDoc,
  LayoutMode,
  PageSettings,
  Viewport,
} from '../model/index.js';
import { DEFAULT_EDGE_COLOR, DOC_FORMAT, CURRENT_DOC_VERSION } from '../model/index.js';
import { createCommandStack } from './command.js';
import type { Command, CommandStack } from './command.js';
import type { DocMeta, StorageAdapter } from './adapters.js';
import { detectConflicts } from '../graph/index.js';
import type { CycleIssue, MultiParentIssue } from '../graph/index.js';
import { layoutTree } from '../layout/index.js';
import type { LayoutInput, LayoutPosition, MeasuredSize } from '../layout/index.js';
import { serializeKBNote, parseKBNote } from '../serialize/index.js';

/**
 * EditorStore：全局编辑状态 + 全部 action。
 * 实现：zustand(vanilla) + immer middleware + 自研 Command 撤销栈。
 * 所有 doc 写操作经 CommandStack（可撤销、coalesce、宏）；UI 态用 immer draft。
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

/** 待裁决冲突负载（addEdge / 导入 / 粘贴后检测到）。 */
export interface PendingConflicts {
  multiParents: MultiParentIssue[];
  cycles: CycleIssue[];
  /** 触发本次冲突的新增边 id（用户取消时用于精确回退）。 */
  triggerEdgeIds: string[];
}

/** 一条搜索命中。 */
export interface SearchResultItem {
  nodeId: string;
  snippet: string;
}

/** 内部剪贴板（深拷贝）。 */
export interface ClipboardData {
  nodes: BlockNode[];
  edges: Edge[];
}

/** 对齐方式（纯几何）。 */
export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
/** 分布轴向。 */
export type DistributeAxis = 'horizontal' | 'vertical';

/** flyTo 目标（web 动画消费）。 */
export interface FocusTarget {
  nodeId: string;
  nonce: number;
}

/** analyzer 返回形状（与 graph.GraphAnalysis 冲突部分结构一致）。 */
interface GraphAnalysisLike {
  multiParents: MultiParentIssue[];
  cycles: CycleIssue[];
}

/** layoutEngine 返回形状。 */
interface LayoutResultLike {
  positions: Record<string, LayoutPosition>;
}

/**
 * 创建 editor store 所需的可注入依赖。
 * 浏览器能力一律经此注入，保证 core 零 DOM。
 */
export interface StoreDeps {
  /** 本地文档/附件存储（存在时启用防抖自动保存）。 */
  storage?: StorageAdapter;
  /** 平台外壳能力（文件选择/打印/分享）——web 注入，store 不直接调用。 */
  host?: unknown;
  /** 时钟注入（默认 Date.now）。 */
  now?: () => number;
  /** 图冲突检测（默认 graph.detectConflicts）。 */
  analyzer?: (nodes: BlockNode[], edges: Edge[]) => GraphAnalysisLike;
  /** 布局引擎（默认 layout.layoutTree）。 */
  layoutEngine?: (input: LayoutInput, mode: LayoutMode) => LayoutResultLike;
  /** UI 冲突弹窗（web 注入）；resolve 给裁决，null = 取消回滚。 */
  resolveConflictUi?: (pending: PendingConflicts) => Promise<ConflictResolution | null>;
}

/** Store 状态形状。 */
export interface EditorState {
  /** 当前打开的文档。 */
  doc: KBNoteDoc;
  /** 当前文档 id（= doc.id）。 */
  currentDocId: string;
  /** 文档列表元信息（来自 storage.listDocs）。 */
  docs: DocMeta[];

  /** 选中的节点 id 集合。 */
  selection: Set<string>;
  /** 选中的边 id 集合。 */
  edgeSelection: Set<string>;
  /** 当前正在编辑（块内 Tiptap）的节点 id。 */
  editingNodeId: string | null;
  /** 当前交互模式。 */
  mode: InteractionMode;
  /** 画布视口。 */
  viewport: Viewport;

  /** 撤销/重做可用。 */
  canUndo: boolean;
  canRedo: boolean;

  /** 待裁决冲突（null = 无）。 */
  pendingConflicts: PendingConflicts | null;

  /** 布局 UI 偏好（非 doc 持久化）。 */
  layoutUi: { scopeSelected: boolean };
  /** web 侧 ResizeObserver 实测尺寸。 */
  measuredSizes: Record<string, MeasuredSize>;
  /** 布局预览位置（不落 doc）；null = 无预览。 */
  layoutPreview: Record<string, LayoutPosition> | null;

  /** 搜索索引句柄。 */
  searchIndex: SearchIndexHandle;
  searchQuery: string;
  searchResults: SearchResultItem[];
  /** 搜索结果高亮的节点 id。 */
  searchHighlight: Set<string>;

  /** 内部剪贴板。 */
  clipboard: ClipboardData | null;

  /** 画布偏好。 */
  prefs: { showGrid: boolean; snapToGrid: boolean };
  /** doc 是否相对上次保存有改动。 */
  dirty: boolean;
  /** 保存状态与时间戳。 */
  saveState: SaveState;
  savedAt: number | null;

  /** flyTo 目标（每次 nonce++ 触发动画）。 */
  lastFocus: FocusTarget | null;
}

/**
 * 全部 action 签名。
 * 约定：所有写操作内部走 Command（可撤销）；content/move/resize 走 coalesceKey 防抖合并。
 */
export interface EditorActions {
  // ---- 文档级 ----
  /** 新建空白文档（替换当前 doc，重置撤销栈）。 */
  newDoc(): void;
  /** 重命名当前文档。 */
  renameDoc(title: string): void;
  /** 以导入的文档替换当前。 */
  loadDoc(doc: KBNoteDoc): void;
  /** 复制当前文档为新 id 的副本并切换过去。 */
  duplicateDoc(): Promise<void>;
  /** 按 id 从 storage 打开文档。 */
  openDoc(id: string): Promise<void>;
  /** 从 storage 刷新文档列表。 */
  listDocs(): Promise<void>;
  /** 删除指定文档（storage）。 */
  deleteDoc(id: string): Promise<void>;

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
  /** 更新块样式（颜色/背景/边框补丁）。 */
  updateNodeStyle(id: string, patch: Partial<BlockStyle>): void;

  // ---- 边（父子）----
  /** 新增父子边；若产生多父/成环，挂起冲突等待 resolveConflicts。 */
  addEdge(
    source: string,
    target: string,
    opts?: {
      label?: string;
      color?: string;
      sourceHandle?: Edge['sourceHandle'];
      targetHandle?: Edge['targetHandle'];
    },
  ): void;
  /** 删除边。 */
  deleteEdge(id: string): void;
  /** 设置边颜色。 */
  setEdgeColor(id: string, color: string): void;
  /** 设置边文字标签。 */
  setEdgeLabel(id: string, label: string): void;

  // ---- 导图键盘建块 ----
  /** Tab：在选中块下新建子块并连父子边。 */
  tabAddChild(): void;
  /** Enter：在同级新建兄弟块。 */
  enterAddSibling(): void;
  /** Shift+Tab：把当前块升级（脱离当前父，挂到祖父）。 */
  shiftTabDemote(): void;

  // ---- 对齐 / 分布（纯几何，宏命令）----
  alignSelection(mode: AlignMode): void;
  distributeSelection(axis: DistributeAxis): void;

  // ---- 布局（宏命令，可撤销）----
  /** 一键整理：预览→应用→落位，整体作为一条可撤销宏。 */
  applyLayout(): void;
  /** 用 measuredSizes + layoutEngine 算位置写入 layoutPreview（不落 doc）。 */
  previewLayout(): void;
  /** 把预览位置作为一条宏命令落 doc、清预览，单次 undo 整体回退。 */
  confirmLayout(): void;
  /** 取消预览（不落 doc）。 */
  cancelLayout(): void;
  setLayoutMode(mode: LayoutMode): void;
  setSpacing(rankSpacing: number, nodeSpacing: number): void;
  toggleScopeSelected(): void;

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

  // ---- 页面 / 测量 ----
  setPageSettings(patch: Partial<PageSettings>): void;
  setPageOrigin(origin: { x: number; y: number }): void;
  setMeasuredSizes(map: Record<string, MeasuredSize>): void;

  // ---- 搜索 ----
  setSearchQuery(query: string): void;
  setSearchResults(results: SearchResultItem[]): void;
  clearSearchHighlight(): void;
  /** web 写入不透明索引句柄。 */
  setSearchIndex(handle: SearchIndexHandle): void;

  // ---- 选择 / 模式 ----
  setSelection(ids: string[]): void;
  setEdgeSelection(ids: string[]): void;
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

  // ---- 导入导出 / 保存 ----
  /** 序列化为 .kbnote 文本。 */
  exportKBNoteText(): string;
  /** 解析 .kbnote 文本并加载（触发冲突检测）。 */
  importKBNoteText(json: string): void;
  /** 触发一次立即落盘（不等防抖窗口）。 */
  requestSave(): void;
  /** flyTo：仅记录 viewport 目标，web 动画消费。 */
  flyToNode(nodeId: string): void;

  // ---- 保存状态 ----
  setSaveState(s: SaveState): void;
  setPrefs(patch: Partial<{ showGrid: boolean; snapToGrid: boolean }>): void;
}

/** 组合后的 store：state + actions。 */
export type EditorStore = EditorState & EditorActions;

/** createEditorStore 返回值：zustand vanilla store（web 用 useStore 接线）。 */
export type EditorStoreApi = StoreApi<EditorStore>;

/** 深拷贝（core 无 structuredClone；doc 全是 JSON 数据）。 */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeBlock(id: string, type: BlockType, x: number, y: number): BlockNode {
  const node: BlockNode = {
    id,
    type,
    x,
    y,
    width: 220,
    height: 80,
    content: { format: 'tiptap-json', data: { type: 'doc', content: [] } },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
  };
  if (type === 'todo') node.todo = { checked: false };
  return node;
}

function blankDoc(now: number): KBNoteDoc {
  return {
    format: DOC_FORMAT,
    version: CURRENT_DOC_VERSION,
    id: nanoid(),
    title: '未命名画布',
    board: { createdAt: now, updatedAt: now },
    nodes: [],
    edges: [],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: {
      size: 'A4',
      orientation: 'portrait',
      marginMm: 15,
      mode: 'fit',
      showPageBreak: true,
      colorMode: 'color',
      header: false,
      footer: false,
      showPageNumbers: false,
      pageBreaks: [],
    },
    assetRefs: [],
  };
}

/**
 * 创建 editor store（zustand vanilla + immer + Command 栈）。
 * @param init  初始文档
 * @param deps  可注入依赖（storage / now / analyzer / layoutEngine / resolveConflictUi）
 */
export function createEditorStore(init: KBNoteDoc, deps: StoreDeps = {}): EditorStoreApi {
  const now = deps.now ?? (() => Date.now());
  const analyze: NonNullable<StoreDeps['analyzer']> =
    deps.analyzer ?? ((nodes, edges) => detectConflicts(nodes, edges));
  const runLayout: NonNullable<StoreDeps['layoutEngine']> = deps.layoutEngine ?? layoutTree;

  let stack: CommandStack = createCommandStack(init, { now, coalesceWindowMs: 800 });
  let saveTimer: number | undefined;
  let focusNonce = 0;

  const store = createStore<EditorStore>()(
    immer((set, get) => {
      // ---------- 内部辅助（闭包） ----------
      const syncUndoFlags = () => {
        set((d) => {
          d.canUndo = stack.canUndo();
          d.canRedo = stack.canRedo();
        });
      };

      const flushSave = async () => {
        saveTimer = undefined;
        if (!deps.storage) return;
        set((d) => {
          d.saveState = 'saving';
        });
        try {
          await deps.storage.saveDoc(get().doc);
          set((d) => {
            d.saveState = 'saved';
            d.savedAt = now();
            d.dirty = false;
          });
        } catch {
          set((d) => {
            d.saveState = 'idle';
          });
        }
      };

      const scheduleAutosave = () => {
        set((d) => {
          d.dirty = true;
        });
        if (!deps.storage) return;
        if (saveTimer !== undefined) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          void flushSave();
        }, 500);
      };

      const runCommand = (cmd: Command) => {
        const nextDoc = stack.push(cmd);
        set((d) => {
          d.doc = nextDoc;
          d.dirty = true;
        });
        syncUndoFlags();
        scheduleAutosave();
      };

      const runMacro = (name: string, cmds: Command[]) => {
        if (cmds.length === 0) return;
        const nextDoc = stack.executeMacro(name, cmds);
        set((d) => {
          d.doc = nextDoc;
          d.dirty = true;
        });
        syncUndoFlags();
        scheduleAutosave();
      };

      const mapNode = (doc: KBNoteDoc, id: string, fn: (n: BlockNode) => BlockNode): KBNoteDoc => ({
        ...doc,
        nodes: doc.nodes.map((n) => (n.id === id ? fn(n) : n)),
      });

      /** 切换文档（新建/打开/导入）：重置撤销栈与临时 UI 态。 */
      const switchDoc = (doc: KBNoteDoc) => {
        stack = createCommandStack(doc, { now, coalesceWindowMs: 800 });
        set((d) => {
          d.doc = doc;
          d.currentDocId = doc.id;
          d.selection = new Set();
          d.edgeSelection = new Set();
          d.editingNodeId = null;
          d.viewport = { ...doc.viewport };
          d.pendingConflicts = null;
          d.layoutPreview = null;
          d.searchQuery = '';
          d.searchResults = [];
          d.searchHighlight = new Set();
          d.canUndo = false;
          d.canRedo = false;
          d.dirty = true;
        });
        scheduleAutosave();
      };

      const applyResolution = (resolution: ConflictResolution) => {
        const pending = get().pendingConflicts;
        if (!pending) return;
        const drop = new Set<string>();
        for (const mp of pending.multiParents) {
          const keep = resolution.choosePrimaryParent[mp.nodeId];
          for (const eid of mp.parentEdgeIds) if (eid !== keep) drop.add(eid);
        }
        for (const eid of resolution.breakEdgeIds) drop.add(eid);

        const { doc } = get();
        const cmds: Command[] = [];
        for (const eid of drop) {
          const edge = doc.edges.find((e) => e.id === eid);
          if (!edge) continue;
          cmds.push({
            name: 'drop-edge',
            execute: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== eid) }),
            undo: (d) => ({ ...d, edges: [...d.edges, edge] }),
          });
        }
        runMacro('resolve-conflicts', cmds);
        set((d) => {
          d.pendingConflicts = null;
        });
      };

      /** 检测冲突；有则写 pendingConflicts 并调 UI 弹窗；取消回滚，裁决落定。 */
      const promptConflicts = (triggerEdgeIds: string[], depthBefore: number) => {
        const { doc } = get();
        const { multiParents, cycles } = analyze(doc.nodes, doc.edges);
        if (multiParents.length === 0 && cycles.length === 0) return;
        const pending: PendingConflicts = { multiParents, cycles, triggerEdgeIds };
        set((d) => {
          d.pendingConflicts = pending;
        });
        const resolver = deps.resolveConflictUi;
        if (!resolver) return;
        void resolver(pending)
          .then((resolution) => {
            if (!resolution) {
              // 取消：精确回退本次触发命令
              while (stack.depth().undo > depthBefore) {
                const undone = stack.undo();
                if (undone) {
                  set((d) => {
                    d.doc = undone;
                    d.dirty = true;
                  });
                }
              }
              syncUndoFlags();
              scheduleAutosave();
              set((d) => {
                d.pendingConflicts = null;
              });
              return;
            }
            applyResolution(resolution);
          })
          .catch(() => {
            set((d) => {
              d.pendingConflicts = null;
            });
          });
      };

      /** 当前活跃节点（编辑优先，其次单选）。 */
      const activeNodeId = (): string | null => {
        const s = get();
        if (s.editingNodeId) return s.editingNodeId;
        if (s.selection.size === 1) return [...s.selection][0] ?? null;
        return null;
      };

      return {
        // ================= state =================
        doc: init,
        currentDocId: init.id,
        docs: [],
        selection: new Set(),
        edgeSelection: new Set(),
        editingNodeId: null,
        mode: 'select',
        viewport: { ...init.viewport },
        canUndo: false,
        canRedo: false,
        pendingConflicts: null,
        layoutUi: { scopeSelected: false },
        measuredSizes: {},
        layoutPreview: null,
        searchIndex: null,
        searchQuery: '',
        searchResults: [],
        searchHighlight: new Set(),
        clipboard: null,
        prefs: { showGrid: true, snapToGrid: false },
        dirty: false,
        saveState: 'idle',
        savedAt: null,
        lastFocus: null,

        // ================= 文档级 =================
        newDoc: () => switchDoc(blankDoc(now())),
        renameDoc: (title) => {
          runCommand({
            name: 'rename-doc',
            execute: (d) => ({ ...d, title }),
            undo: (d) => ({ ...d, title: get().doc.title }),
          });
        },
        loadDoc: (doc) => switchDoc(doc),
        duplicateDoc: async () => {
          const copy = deepClone(get().doc);
          copy.id = nanoid();
          copy.title = `${get().doc.title} 副本`;
          copy.board = { createdAt: now(), updatedAt: now() };
          switchDoc(copy);
        },
        openDoc: async (id) => {
          if (!deps.storage) return;
          const doc = await deps.storage.loadDoc(id);
          if (doc) switchDoc(doc);
        },
        listDocs: async () => {
          if (!deps.storage) return;
          const metas = await deps.storage.listDocs();
          set((d) => {
            d.docs = metas;
          });
        },
        deleteDoc: async (id) => {
          if (deps.storage) await deps.storage.deleteDoc(id);
          if (deps.storage) {
            const metas = await deps.storage.listDocs();
            set((d) => {
              d.docs = metas;
            });
          }
          if (get().currentDocId === id) get().newDoc();
        },

        // ================= 节点 CRUD =================
        addNode: (type, x, y) => {
          const id = nanoid();
          const node = makeBlock(id, type, x, y);
          runCommand({
            name: 'add-node',
            execute: (d) => ({ ...d, nodes: [...d.nodes, node] }),
            undo: (d) => ({
              ...d,
              nodes: d.nodes.filter((n) => n.id !== id),
              edges: d.edges.filter((e) => e.source !== id && e.target !== id),
            }),
          });
          set((d) => {
            d.selection = new Set([id]);
          });
          return id;
        },
        addNodes: (nodes) => {
          const ids = new Set(nodes.map((n) => n.id));
          runCommand({
            name: 'add-nodes',
            execute: (d) => ({ ...d, nodes: [...d.nodes, ...nodes] }),
            undo: (d) => ({
              ...d,
              nodes: d.nodes.filter((n) => !ids.has(n.id)),
              edges: d.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
            }),
          });
        },
        deleteNode: (id) => {
          const { doc } = get();
          const node = doc.nodes.find((n) => n.id === id);
          if (!node) return;
          const removedEdges = doc.edges.filter((e) => e.source === id || e.target === id);
          runCommand({
            name: 'delete-node',
            execute: (d) => ({
              ...d,
              nodes: d.nodes.filter((n) => n.id !== id),
              edges: d.edges.filter((e) => e.source !== id && e.target !== id),
            }),
            undo: (d) => ({
              ...d,
              nodes: [...d.nodes, node],
              edges: [...d.edges, ...removedEdges],
            }),
          });
        },
        deleteNodes: (ids) => {
          if (ids.length === 0) return;
          const idSet = new Set(ids);
          const { doc } = get();
          const removedNodes = doc.nodes.filter((n) => idSet.has(n.id));
          const removedEdges = doc.edges.filter((e) => idSet.has(e.source) || idSet.has(e.target));
          runCommand({
            name: 'delete-nodes',
            execute: (d) => ({
              ...d,
              nodes: d.nodes.filter((n) => !idSet.has(n.id)),
              edges: d.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target)),
            }),
            undo: (d) => ({
              ...d,
              nodes: [...d.nodes, ...removedNodes],
              edges: [...d.edges, ...removedEdges],
            }),
          });
        },
        updateContent: (id, data) => {
          const node = get().doc.nodes.find((n) => n.id === id);
          if (!node) return;
          const oldData = node.content.data;
          runCommand({
            name: 'update-content',
            coalesceKey: `content:${id}`,
            execute: (d) => mapNode(d, id, (n) => ({ ...n, content: { format: 'tiptap-json', data } })),
            undo: (d) => mapNode(d, id, (n) => ({ ...n, content: { format: 'tiptap-json', data: oldData } })),
          });
        },
        moveNode: (id, x, y) => {
          const node = get().doc.nodes.find((n) => n.id === id);
          if (!node) return;
          const ox = node.x;
          const oy = node.y;
          runCommand({
            name: 'move-node',
            coalesceKey: 'move',
            execute: (d) => mapNode(d, id, (n) => ({ ...n, x, y })),
            undo: (d) => mapNode(d, id, (n) => ({ ...n, x: ox, y: oy })),
          });
        },
        resizeNode: (id, width, height) => {
          const node = get().doc.nodes.find((n) => n.id === id);
          if (!node) return;
          const ow = node.width;
          const oh = node.height;
          runCommand({
            name: 'resize-node',
            coalesceKey: 'resize',
            execute: (d) => mapNode(d, id, (n) => ({ ...n, width, height })),
            undo: (d) => mapNode(d, id, (n) => ({ ...n, width: ow, height: oh })),
          });
        },
        updateNodeStyle: (id, patch) => {
          const node = get().doc.nodes.find((n) => n.id === id);
          if (!node) return;
          runCommand({
            name: 'update-node-style',
            execute: (d) => mapNode(d, id, (n) => ({ ...n, style: { ...n.style, ...patch } })),
            undo: (d) => mapNode(d, id, (n) => ({ ...n, style: { ...node.style } })),
          });
        },

        // ================= 边 =================
        addEdge: (source, target, opts) => {
          const { doc } = get();
          if (source === target) return; // 自环禁止
          if (!doc.nodes.some((n) => n.id === source)) return;
          if (!doc.nodes.some((n) => n.id === target)) return;
          if (doc.edges.some((e) => e.source === source && e.target === target)) return; // 重复边
          const edge: Edge = {
            id: nanoid(),
            source,
            target,
            sourceHandle: opts?.sourceHandle ?? 'right',
            targetHandle: opts?.targetHandle ?? 'left',
            label: opts?.label ?? '',
            directed: true,
            style: { color: opts?.color ?? DEFAULT_EDGE_COLOR.hex },
          };
          const depthBefore = stack.depth().undo;
          runCommand({
            name: 'add-edge',
            execute: (d) => ({ ...d, edges: [...d.edges, edge] }),
            undo: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== edge.id) }),
          });
          promptConflicts([edge.id], depthBefore);
        },
        deleteEdge: (id) => {
          const edge = get().doc.edges.find((e) => e.id === id);
          if (!edge) return;
          runCommand({
            name: 'delete-edge',
            execute: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== id) }),
            undo: (d) => ({ ...d, edges: [...d.edges, edge] }),
          });
        },
        setEdgeColor: (id, color) => {
          const edge = get().doc.edges.find((e) => e.id === id);
          if (!edge) return;
          runCommand({
            name: 'set-edge-color',
            execute: (d) => ({
              ...d,
              edges: d.edges.map((e) => (e.id === id ? { ...e, style: { color } } : e)),
            }),
            undo: (d) => ({
              ...d,
              edges: d.edges.map((e) => (e.id === id ? { ...e, style: { color: edge.style.color } } : e)),
            }),
          });
        },
        setEdgeLabel: (id, label) => {
          const edge = get().doc.edges.find((e) => e.id === id);
          if (!edge) return;
          const old = edge.label;
          runCommand({
            name: 'set-edge-label',
            execute: (d) => ({ ...d, edges: d.edges.map((e) => (e.id === id ? { ...e, label } : e)) }),
            undo: (d) => ({ ...d, edges: d.edges.map((e) => (e.id === id ? { ...e, label: old } : e)) }),
          });
        },

        // ================= 导图键盘建块 =================
        tabAddChild: () => {
          const parentId = activeNodeId();
          if (!parentId) return;
          const { doc } = get();
          const parent = doc.nodes.find((n) => n.id === parentId);
          if (!parent) return;
          const childId = nanoid();
          const edgeId = nanoid();
          const x = parent.x + parent.width + doc.layout.rankSpacing;
          const y = parent.y;
          const child = makeBlock(childId, 'text', x, y);
          const edge: Edge = {
            id: edgeId,
            source: parentId,
            target: childId,
            sourceHandle: 'right',
            targetHandle: 'left',
            label: '',
            directed: true,
            style: { color: DEFAULT_EDGE_COLOR.hex },
          };
          const depthBefore = stack.depth().undo;
          runMacro('tab-add-child', [
            {
              name: 'add-child',
              execute: (d) => ({ ...d, nodes: [...d.nodes, child] }),
              undo: (d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== childId) }),
            },
            {
              name: 'link-child',
              execute: (d) => ({ ...d, edges: [...d.edges, edge] }),
              undo: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== edgeId) }),
            },
          ]);
          set((d) => {
            d.selection = new Set([childId]);
            d.editingNodeId = childId;
          });
          promptConflicts([edgeId], depthBefore);
        },
        enterAddSibling: () => {
          const curId = activeNodeId();
          const { doc } = get();
          const sibId = nanoid();
          if (!curId) {
            const node = makeBlock(sibId, 'text', 40, 40);
            runCommand({
              name: 'add-root',
              execute: (d) => ({ ...d, nodes: [...d.nodes, node] }),
              undo: (d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== sibId) }),
            });
            set((d) => {
              d.selection = new Set([sibId]);
              d.editingNodeId = sibId;
            });
            return;
          }
          const cur = doc.nodes.find((n) => n.id === curId);
          if (!cur) return;
          const parentEdge = doc.edges.find((e) => e.target === curId);
          const sib = makeBlock(sibId, 'text', cur.x + 24, cur.y + cur.height + 40);
          const cmds: Command[] = [
            {
              name: 'add-sibling',
              execute: (d) => ({ ...d, nodes: [...d.nodes, sib] }),
              undo: (d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== sibId) }),
            },
          ];
          let edgeId: string | null = null;
          if (parentEdge) {
            edgeId = nanoid();
            const edge: Edge = {
              id: edgeId,
              source: parentEdge.source,
              target: sibId,
              sourceHandle: 'right',
              targetHandle: 'left',
              label: '',
              directed: true,
              style: { color: DEFAULT_EDGE_COLOR.hex },
            };
            cmds.push({
              name: 'link-sibling',
              execute: (d) => ({ ...d, edges: [...d.edges, edge] }),
              undo: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== edgeId) }),
            });
          }
          const depthBefore = stack.depth().undo;
          runMacro('enter-add-sibling', cmds);
          set((d) => {
            d.selection = new Set([sibId]);
            d.editingNodeId = sibId;
          });
          if (edgeId) promptConflicts([edgeId], depthBefore);
        },
        shiftTabDemote: () => {
          const curId = activeNodeId();
          if (!curId) return;
          const { doc } = get();
          if (!doc.nodes.some((n) => n.id === curId)) return;
          const parentEdge = doc.edges.find((e) => e.target === curId);
          if (!parentEdge) return; // 已是根
          const grandParentEdge = doc.edges.find((e) => e.target === parentEdge.source);
          const newEdgeId = nanoid();
          const cmds: Command[] = [
            {
              name: 'unlink-parent',
              execute: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== parentEdge.id) }),
              undo: (d) => ({ ...d, edges: [...d.edges, parentEdge] }),
            },
          ];
          if (grandParentEdge) {
            const newEdge: Edge = {
              id: newEdgeId,
              source: grandParentEdge.source,
              target: curId,
              sourceHandle: 'right',
              targetHandle: 'left',
              label: '',
              directed: true,
              style: { color: DEFAULT_EDGE_COLOR.hex },
            };
            cmds.push({
              name: 'relink-grandparent',
              execute: (d) => ({ ...d, edges: [...d.edges, newEdge] }),
              undo: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== newEdgeId) }),
            });
          }
          const depthBefore = stack.depth().undo;
          runMacro('shift-tab-demote', cmds);
          if (grandParentEdge) promptConflicts([newEdgeId], depthBefore);
        },

        // ================= 对齐 / 分布 =================
        alignSelection: (mode) => {
          const { doc, selection } = get();
          const selected = doc.nodes.filter((n) => selection.has(n.id));
          if (selected.length < 2) return;
          const xs = selected.map((n) => n.x);
          const ys = selected.map((n) => n.y);
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const minY = Math.min(...ys);
          const maxY = Math.max(...ys);
          const cmds: Command[] = selected.map((n) => {
            let x = n.x;
            let y = n.y;
            switch (mode) {
              case 'left':
                x = minX;
                break;
              case 'right':
                x = maxX;
                break;
              case 'hcenter':
                x = (minX + maxX) / 2 - n.width / 2;
                break;
              case 'top':
                y = minY;
                break;
              case 'bottom':
                y = maxY;
                break;
              case 'vcenter':
                y = (minY + maxY) / 2 - n.height / 2;
                break;
            }
            return {
              name: 'align',
              execute: (d) => mapNode(d, n.id, (o) => ({ ...o, x, y })),
              undo: (d) => mapNode(d, n.id, (o) => ({ ...o, x: n.x, y: n.y })),
            };
          });
          runMacro('align-selection', cmds);
        },
        distributeSelection: (axis) => {
          const { doc, selection } = get();
          const selected = doc.nodes.filter((n) => selection.has(n.id));
          if (selected.length < 3) return;
          const cmds: Command[] = [];
          if (axis === 'horizontal') {
            const sorted = [...selected].sort((a, b) => a.x - b.x);
            const first = sorted[0]!;
            const last = sorted[sorted.length - 1]!;
            const span = last.x + last.width - first.x;
            const totalWidth = sorted.reduce((w, n) => w + n.width, 0);
            const gap = (span - totalWidth) / (sorted.length - 1);
            let cursor = first.x;
            for (const n of sorted) {
              cmds.push({
                name: 'distribute',
                execute: (d) => mapNode(d, n.id, (o) => ({ ...o, x: cursor, y: n.y })),
                undo: (d) => mapNode(d, n.id, (o) => ({ ...o, x: n.x, y: n.y })),
              });
              cursor += n.width + gap;
            }
          } else {
            const sorted = [...selected].sort((a, b) => a.y - b.y);
            const first = sorted[0]!;
            const last = sorted[sorted.length - 1]!;
            const span = last.y + last.height - first.y;
            const totalHeight = sorted.reduce((h, n) => h + n.height, 0);
            const gap = (span - totalHeight) / (sorted.length - 1);
            let cursor = first.y;
            for (const n of sorted) {
              cmds.push({
                name: 'distribute',
                execute: (d) => mapNode(d, n.id, (o) => ({ ...o, x: n.x, y: cursor })),
                undo: (d) => mapNode(d, n.id, (o) => ({ ...o, x: n.x, y: n.y })),
              });
              cursor += n.height + gap;
            }
          }
          runMacro('distribute-selection', cmds);
        },

        // ================= 布局 =================
        applyLayout: () => {
          get().previewLayout();
          get().confirmLayout();
        },
        previewLayout: () => {
          const s = get();
          const input: LayoutInput = {
            nodes: s.doc.nodes,
            edges: s.doc.edges,
            rankSpacing: s.doc.layout.rankSpacing,
            nodeSpacing: s.doc.layout.nodeSpacing,
            measured: s.measuredSizes,
            pinned: new Set(s.doc.nodes.filter((n) => n.pinned).map((n) => n.id)),
            collapsed: Object.fromEntries(
              s.doc.nodes.filter((n) => n.collapsed).map((n) => [n.id, true]),
            ),
          };
          const result = runLayout(input, s.doc.layout.mode);
          set((d) => {
            d.layoutPreview = result.positions;
          });
        },
        confirmLayout: () => {
          const s = get();
          if (!s.layoutPreview) return;
          const cmds: Command[] = [];
          for (const [id, pos] of Object.entries(s.layoutPreview)) {
            const node = s.doc.nodes.find((n) => n.id === id);
            if (!node) continue;
            cmds.push({
              name: 'place',
              execute: (d) => mapNode(d, id, (n) => ({ ...n, x: pos.x, y: pos.y })),
              undo: (d) => mapNode(d, id, (n) => ({ ...n, x: node.x, y: node.y })),
            });
          }
          runMacro('confirm-layout', cmds);
          set((d) => {
            d.layoutPreview = null;
          });
        },
        cancelLayout: () => {
          set((d) => {
            d.layoutPreview = null;
          });
        },
        setLayoutMode: (mode) => {
          set((d) => {
            d.doc.layout.mode = mode;
            d.dirty = true;
          });
          scheduleAutosave();
        },
        setSpacing: (rankSpacing, nodeSpacing) => {
          set((d) => {
            d.doc.layout.rankSpacing = rankSpacing;
            d.doc.layout.nodeSpacing = nodeSpacing;
            d.dirty = true;
          });
          scheduleAutosave();
        },
        toggleScopeSelected: () => {
          set((d) => {
            d.layoutUi.scopeSelected = !d.layoutUi.scopeSelected;
          });
        },

        // ================= 块属性 =================
        togglePin: (id) => {
          const node = get().doc.nodes.find((n) => n.id === id);
          if (!node) return;
          const v = !node.pinned;
          runCommand({
            name: 'toggle-pin',
            execute: (d) => mapNode(d, id, (n) => ({ ...n, pinned: v })),
            undo: (d) => mapNode(d, id, (n) => ({ ...n, pinned: !v })),
          });
        },
        toggleCollapse: (id) => {
          const node = get().doc.nodes.find((n) => n.id === id);
          if (!node) return;
          const v = !node.collapsed;
          runCommand({
            name: 'toggle-collapse',
            execute: (d) => mapNode(d, id, (n) => ({ ...n, collapsed: v })),
            undo: (d) => mapNode(d, id, (n) => ({ ...n, collapsed: !v })),
          });
        },
        toggleTodo: (id) => {
          const node = get().doc.nodes.find((n) => n.id === id);
          if (!node) return;
          const v = !(node.todo?.checked ?? false);
          runCommand({
            name: 'toggle-todo',
            execute: (d) => mapNode(d, id, (n) => ({ ...n, todo: { checked: v } })),
            undo: (d) => mapNode(d, id, (n) => ({ ...n, todo: { checked: !v } })),
          });
        },

        // ================= 标签 =================
        addTagToNode: (nodeId, tagId) => {
          const node = get().doc.nodes.find((n) => n.id === nodeId);
          if (!node || node.tags.includes(tagId)) return;
          runCommand({
            name: 'add-tag',
            execute: (d) => mapNode(d, nodeId, (n) => ({ ...n, tags: [...n.tags, tagId] })),
            undo: (d) => mapNode(d, nodeId, (n) => ({ ...n, tags: n.tags.filter((t) => t !== tagId) })),
          });
        },
        removeTagFromNode: (nodeId, tagId) => {
          runCommand({
            name: 'remove-tag',
            execute: (d) => mapNode(d, nodeId, (n) => ({ ...n, tags: n.tags.filter((t) => t !== tagId) })),
            undo: (d) => mapNode(d, nodeId, (n) => ({ ...n, tags: [...n.tags, tagId] })),
          });
        },

        // ================= 页面 / 测量 =================
        setPageSettings: (patch) => {
          set((d) => {
            d.doc.page = { ...d.doc.page, ...patch };
            d.dirty = true;
          });
          scheduleAutosave();
        },
        setPageOrigin: (origin) => {
          set((d) => {
            d.doc.page.pageOrigin = origin;
            d.dirty = true;
          });
          scheduleAutosave();
        },
        setMeasuredSizes: (map) => {
          set((d) => {
            d.measuredSizes = map;
          });
        },

        // ================= 搜索 =================
        setSearchQuery: (query) => {
          set((d) => {
            d.searchQuery = query;
            if (!query) {
              d.searchResults = [];
              d.searchHighlight = new Set();
            }
          });
        },
        setSearchResults: (results) => {
          set((d) => {
            d.searchResults = results;
            d.searchHighlight = new Set(results.map((r) => r.nodeId));
          });
        },
        clearSearchHighlight: () => {
          set((d) => {
            d.searchHighlight = new Set();
          });
        },
        setSearchIndex: (handle) => {
          set((d) => {
            d.searchIndex = handle;
          });
        },

        // ================= 选择 / 模式 =================
        setSelection: (ids) => {
          set((d) => {
            d.selection = new Set(ids);
          });
        },
        setEdgeSelection: (ids) => {
          set((d) => {
            d.edgeSelection = new Set(ids);
          });
        },
        setMode: (mode) => {
          set((d) => {
            d.mode = mode;
          });
        },
        setEditingNode: (id) => {
          set((d) => {
            d.editingNodeId = id;
          });
        },
        setViewport: (vp) => {
          set((d) => {
            d.viewport = { ...vp };
          });
        },

        // ================= 剪贴板 =================
        copy: () => {
          const { doc, selection } = get();
          const nodes = doc.nodes.filter((n) => selection.has(n.id));
          const edges = doc.edges.filter((e) => selection.has(e.source) && selection.has(e.target));
          set((d) => {
            d.clipboard = deepClone({ nodes, edges });
          });
        },
        cut: () => {
          get().copy();
          const ids = [...get().selection];
          get().deleteNodes(ids);
        },
        paste: () => {
          const s = get();
          if (!s.clipboard || s.clipboard.nodes.length === 0) return;
          const oldToNew = new Map<string, string>();
          for (const n of s.clipboard.nodes) oldToNew.set(n.id, nanoid());
          const nodes: BlockNode[] = s.clipboard.nodes.map((n) => {
            const copy = deepClone(n);
            copy.id = oldToNew.get(n.id)!;
            copy.x += 24;
            copy.y += 24;
            copy.parentId = copy.parentId ? (oldToNew.get(copy.parentId) ?? null) : null;
            return copy;
          });
          const edges: Edge[] = s.clipboard.edges.map((e) => {
            const copy = deepClone(e);
            copy.id = nanoid();
            copy.source = oldToNew.get(e.source)!;
            copy.target = oldToNew.get(e.target)!;
            return copy;
          });
          const newNodeIds = new Set(nodes.map((n) => n.id));
          const newEdgeIds = new Set(edges.map((e) => e.id));
          runCommand({
            name: 'paste',
            execute: (d) => ({ ...d, nodes: [...d.nodes, ...nodes], edges: [...d.edges, ...edges] }),
            undo: (d) => ({
              ...d,
              nodes: d.nodes.filter((n) => !newNodeIds.has(n.id)),
              edges: d.edges.filter((e) => !newEdgeIds.has(e.id)),
            }),
          });
          set((d) => {
            d.selection = new Set(nodes.map((n) => n.id));
          });
        },
        duplicate: () => {
          get().copy();
          get().paste();
        },

        // ================= 撤销重做 =================
        undo: () => {
          const undone = stack.undo();
          if (undone) {
            set((d) => {
              d.doc = undone;
              d.dirty = true;
            });
          }
          syncUndoFlags();
          scheduleAutosave();
        },
        redo: () => {
          const redone = stack.redo();
          if (redone) {
            set((d) => {
              d.doc = redone;
              d.dirty = true;
            });
          }
          syncUndoFlags();
          scheduleAutosave();
        },

        // ================= 冲突裁决 =================
        resolveConflicts: (resolution) => applyResolution(resolution),

        // ================= 导入导出 / 保存 =================
        exportKBNoteText: () => serializeKBNote(get().doc),
        importKBNoteText: (json) => {
          const { doc } = parseKBNote(json);
          switchDoc(doc);
          promptConflicts([], 0);
        },
        requestSave: () => {
          void flushSave();
        },
        flyToNode: (nodeId) => {
          focusNonce += 1;
          set((d) => {
            d.lastFocus = { nodeId, nonce: focusNonce };
          });
        },

        // ================= 保存状态 =================
        setSaveState: (s) => {
          set((d) => {
            d.saveState = s;
          });
        },
        setPrefs: (patch) => {
          set((d) => {
            d.prefs = { ...d.prefs, ...patch };
          });
        },
      };
    }),
  );

  return store;
}
