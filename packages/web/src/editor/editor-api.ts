import type {
  BlockNode,
  BlockStyle,
  BlockType,
  Edge,
  InteractionMode,
  KBNoteDoc,
  SaveState,
  Viewport,
} from '@drawpaper/core';
import type { TagFilter } from './lib/filter-match';

/**
 * EditorApi —— Wave1-D 画布编辑层与「真实 store（Wave1-C）」之间的结构型接缝。
 *
 * 设计原则：
 * - 所有组件只通过本接口（React Context 注入）拿状态与回调，**禁止 import src/store**。
 * - 状态切片以「只读快照」暴露：CanvasEditor 用 useSyncExternalStore 订阅
 *   `getState()/subscribe()`，Wave2 把真实 zustand store 适配成本形状即可。
 * - 写操作全部是回调，命名与 core `EditorStore` action 语义对齐（见 core/store/store.ts）。
 */

/** 一键整理预览时给单个节点的幽灵落点（世界坐标 + 尺寸）。 */
export interface LayoutGhost {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 多父冲突候选（一个子节点的全部入边 → 父候选）。 */
export interface MultiParentConflict {
  nodeId: string;
  parentEdgeIds: string[];
  parentIds: string[];
}

/** 成环冲突（环上的节点序列与边；断开任意一条即可破环）。 */
export interface CycleConflict {
  nodeIds: string[];
  edgeIds: string[];
}

/**
 * 待裁决冲突集合。addEdge 产生多父/成环时由 store 挂起：
 * 边先 provisional 加入画布（半透明/待决），用户在弹窗中裁决后才落定。
 */
export interface PendingConflicts {
  /** 本次新增、等待裁决的边 id（取消弹窗时整体回滚）。 */
  provisionalEdgeIds: string[];
  multiParents: MultiParentConflict[];
  cycles: CycleConflict[];
}

/** 弹窗提交的裁决结果（与 core ConflictResolution 语义一致）。 */
export interface ConflictResolutionInput {
  /** nodeId → 保留为主父的 edgeId。 */
  choosePrimaryParent: Record<string, string>;
  /** 要断开的环边 id。 */
  breakEdgeIds: string[];
}

/** 画板偏好（P0 仅网格磁吸开关；更多偏好后续挂这里）。 */
export interface EditorPrefs {
  gridSnap: boolean;
}

/** 完整只读快照。 */
export interface EditorSnapshot {
  doc: KBNoteDoc;
  selection: ReadonlySet<string>;
  editingNodeId: string | null;
  mode: InteractionMode;
  viewport: Viewport;
  /** 一键整理预览幽灵落点；null = 无预览。 */
  layoutPreview: Readonly<Record<string, LayoutGhost>> | null;
  /** 待裁决冲突；null = 无弹窗。 */
  pendingConflicts: PendingConflicts | null;
  searchHighlight: ReadonlySet<string>;
  saveState: SaveState;
  prefs: EditorPrefs;
  /** 搜索/大纲飞块：{ nodeId, ts }；画布侧消费后做 fitCenter + 闪烁高亮。 */
  lastFocus: { nodeId: string; ts: number } | null;
  /** 最近一次 undo/redo 事件（含命令名 + 递增 nonce）；宏撤销后画布据此回位相机。 */
  historyEvent: { kind: 'undo' | 'redo'; name: string; nonce: number } | null;
  /**
   * 聚焦分支的节点 id（P1 §4.4）。非聚焦集合（祖先链+子树之外）的节点降透明度/隐藏。
   * null = 不聚焦。由 store/面板 agent 驱动，editor 消费。
   * 可选：并行接缝，Wave4 真实 store 接齐；消费侧用 `?? null` 兜底。
   */
  focusNodeId?: string | null;
  /** 标签筛选（P1 §4.8）：非命中节点降透明度。空筛选 = 不筛选。 */
  tagFilter?: TagFilter;
  /**
   * 手动移动过、应被「增量整理」跳过的节点 id（不画 ghost）。
   * store 侧接线由 Wave4 完成；editor 仅消费。
   */
  manualFixed?: ReadonlySet<string>;
  /**
   * 每个节点的直接子节点数（source=父）。一次扫边预计算，
   * 供折叠角标等高频组件 O(1) 读取，避免在 selector 里对全量边 reduce。
   */
  childCount?: Record<string, number>;
}

/** 块样式补丁（外观操作：8 色标签色点 = bg；文字色 = color）。 */
export type BlockStylePatch = Partial<Pick<BlockStyle, 'color' | 'bg' | 'border'>>;

export interface EditorApi {
  // ---- 状态订阅（useSyncExternalStore 三件套的最小子集）----
  getState(): EditorSnapshot;
  subscribe(fn: () => void): () => void;

  // ---- 节点 CRUD ----
  addNode(type: BlockType, x: number, y: number): string;
  addNodes(nodes: BlockNode[]): void;
  /** 粘贴/拖拽图片：dataURL 直接进 image 块，返回新块 id。 */
  addImageBlock(dataUrl: string, x: number, y: number): string;
  /**
   * 统一图片摄入（Wave7 P2.1）：粘贴 / 拖入 / 斜杠插入三条入口共用。
   * 压缩 → OPFS 落盘（image.src 存 assetRef）→ 不可用时降级 dataURL 内联。
   * 返回新建块 id、实际写入的 src、以及走了 opfs 还是 dataurl 降级。
   */
  ingestImage(
    file: Blob,
    x: number,
    y: number,
  ): Promise<{ blockId: string; src: string; via: 'opfs' | 'dataurl' }>;
  deleteNodes(ids: string[]): void;
  /** 块内富文本提交（Tiptap JSON；store 侧做防抖合并）。 */
  updateContent(id: string, data: unknown): void;
  /** 块类型切换（斜杠菜单 / hover 工具条）。 */
  setBlockType(id: string, type: BlockType): void;
  moveNode(id: string, x: number, y: number): void;
  resizeNode(id: string, width: number, height: number): void;
  /** ResizeObserver 实测尺寸（派生量，不进 undo 栈）。width 缺省表示只报高度。 */
  setMeasuredSizes(sizes: Record<string, { width?: number; height?: number }>): void;

  // ---- 边（只有父子一种语义）----
  addEdge(
    source: string,
    target: string,
    opts?: {
      label?: string;
      sourceHandle?: Edge['sourceHandle'];
      targetHandle?: Edge['targetHandle'];
    },
  ): void;
  deleteEdge(id: string): void;
  setEdgeColor(id: string, color: string): void;
  setEdgeLabel(id: string, label: string): void;
  /** 设置边手动弯折点（世界坐标，≤64；空数组=恢复贝塞尔）。可撤销。 */
  setEdgePoints?(id: string, points: Array<{ x: number; y: number }>): void;
  /** 多选边一键清除弯折点（合并为一次可撤销宏；P2.1）。 */
  clearEdgesPoints?(ids: readonly string[]): void;
  /** 反转边方向（父↔子），含 source/targetHandle 位交换（P1 §4.3）。可选：Wave4 接真实 store。 */
  reverseEdge?(id: string): void;

  // ---- 导图键盘建块 ----
  tabAddChild(): void;
  enterAddSibling(): void;
  shiftTabDemote(): void;

  // ---- 块属性 ----
  togglePin(id: string): void;
  toggleCollapse(id: string): void;
  toggleTodo(id: string): void;
  setBlockStyle(id: string, patch: BlockStylePatch): void;

  // ---- 选择 / 模式 / 编辑 / 视口 ----
  setSelection(ids: ReadonlySet<string> | readonly string[]): void;
  setMode(mode: InteractionMode): void;
  setEditingNode(id: string | null): void;
  setViewport(vp: Viewport): void;
  addManualPageBreak(id: string, x: number, y: number): void;
  removePageBreak(id: string): void;
  setPageBreaks(breaks: { id: string; x: number; y: number }[]): void;

  // ---- 剪贴板 ----
  copy(): void;
  cut(): void;
  paste(): void;
  duplicate(): void;

  // ---- 撤销 / 重做 ----
  undo(): void;
  redo(): void;

  // ---- 一键整理（预览半透明 ghost → 250ms 落位 → 可撤销宏）----
  previewLayout(): void;
  confirmLayout(): void;
  cancelLayout(): void;

  // ---- 冲突裁决 ----
  resolveConflicts(r: ConflictResolutionInput): void;
  cancelConflicts(): void;

  // ---- 偏好 ----
  setGridSnap(on: boolean): void;

  // ---- 面板接缝（由 panels 消费；画布侧只负责触发）----
  openSearch(): void;
  openExport(): void;

  // ---- 保存（触发 store 防抖落盘）----
  save(): void;

  // ---- P1 聚焦 / 筛选（UI 态，由面板/大纲驱动；可选，Wave4 接真实 store）----
  /** 聚焦某分支；传 null 取消聚焦。 */
  setFocusNode?(id: string | null): void;
  /** 设置标签筛选（any/all 语义）。 */
  setTagFilter?(filter: TagFilter): void;

  // ---- P1 附件上传（经存储 agent；mock 先行；可选，Wave4 接真实 store）----
  /**
   * 上传一个附件，返回 assetRef 引用 id（JSON 内只存引用，Blob 存 OPFS）。
   * 图片仍走 addImageBlock；这里是通用附件（非图片）。
   */
  putImageAsset?(file: File): Promise<{ assetRef: string; name: string; size: number }>;
}
