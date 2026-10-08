import { create } from 'zustand';

/**
 * 纯 UI 态（不属于状态内核、不持久化、不进 undo 栈）：
 * 面板开关 / 搜索激活下标等。EditorApi 与 PanelsApi 的「面板接缝」回调在此落地。
 */
export interface WiringUiState {
  /** 导出弹窗是否打开。 */
  exportOpen: boolean;
  /** 搜索浮层是否打开。 */
  searchOpen: boolean;
  /** 搜索结果键盘激活下标（-1 = 无）。 */
  activeSearchIndex: number;
  /** 快照列表异步加载后 bump，驱动弹窗重渲染。 */
  snapshotsNonce: number;
  /** 回收站列表异步加载后 bump。 */
  trashNonce: number;
  /** 右侧 AI 面板是否展开。 */
  aiPanelOpen: boolean;
  /** 左侧大纲面板是否展开（默认折叠，避免遮挡画布建块区域）。 */
  outlineOpen: boolean;

  /**
   * 打开的活动文件是 v1：在用户确认「保存时升级为 v2、覆盖原文件」之前，
   * 暂停对该文件的防抖写盘（Dexie 自动保存照常）。确认后恢复。
   */
  migrationAwaitingConfirm: boolean;

  /** BacklinksPanel 当前查看的块维度（null = 文档级反链）。 */
  backlinksNodeId: string | null;
  /** 右侧反链面板是否展开。 */
  backlinksOpen: boolean;
  /** 全局图谱总览全屏是否打开。 */
  overviewOpen: boolean;

  /** Wave10：设置→同步面板是否打开。 */
  syncOpen: boolean;

  /**
   * Wave12：原生关闭守卫弹窗是否打开。仅桌面端且「已绑定原生 .kbnote 且脏」时
   * 由 Rust `app:close-requested` 事件置 true；三选一（保存/不保存/取消）。
   */
  closeGuardOpen: boolean;

  /**
   * Wave21：浏览器「本地存储空间不足」引导弹窗（仅 Web/PWA，Tauri 桌面端不弹）。
   * estimate 为预检/失败时读到的 usage/quota（null = estimate 不可用，旧 Safari）。
   */
  quotaDialog: { open: boolean; estimate: { usage: number; quota: number } | null };

  // ============================================================
  // Wave7 P2.1：删除块时的跨文档反链影响确认
  // ============================================================
  /**
   * 待确认的删块请求（有反链影响时非空）。
   * incoming：谁链接到本块（《来源文档》块「摘要」）；
   * outgoing：本块链向谁。incomingLinkIds 供「一并移除」级联。
   */
  blockDeleteRequest: {
    nodeIds: string[];
    incoming: string[];
    outgoing: string[];
    incomingLinkIds: string[];
  } | null;

  setExportOpen(open: boolean): void;
  setSearchOpen(open: boolean): void;
  setActiveSearchIndex(i: number): void;
  bumpSnapshots(): void;
  bumpTrash(): void;
  setAiPanelOpen(open: boolean): void;
  setOutlineOpen(open: boolean): void;
  setMigrationAwaitingConfirm(v: boolean): void;
  setBacklinksNodeId(id: string | null): void;
  setBacklinksOpen(open: boolean): void;
  setOverviewOpen(open: boolean): void;
  setSyncOpen(open: boolean): void;
  setCloseGuardOpen(open: boolean): void;
  setBlockDeleteRequest(req: WiringUiState['blockDeleteRequest']): void;
  setQuotaDialog(open: boolean, estimate?: { usage: number; quota: number } | null): void;
}

export const useWiringUi = create<WiringUiState>((set) => ({
  exportOpen: false,
  searchOpen: false,
  activeSearchIndex: -1,
  snapshotsNonce: 0,
  trashNonce: 0,
  aiPanelOpen: false,
  outlineOpen: false,
  migrationAwaitingConfirm: false,
  backlinksNodeId: null,
  backlinksOpen: false,
  overviewOpen: false,
  syncOpen: false,
  closeGuardOpen: false,
  blockDeleteRequest: null,
  quotaDialog: { open: false, estimate: null },
  setExportOpen: (open) => set({ exportOpen: open }),
  setSearchOpen: (open) => set({ searchOpen: open }),
  setActiveSearchIndex: (i) => set({ activeSearchIndex: i }),
  bumpSnapshots: () => set((s) => ({ snapshotsNonce: s.snapshotsNonce + 1 })),
  bumpTrash: () => set((s) => ({ trashNonce: s.trashNonce + 1 })),
  setAiPanelOpen: (open) => set({ aiPanelOpen: open }),
  setOutlineOpen: (open) => set({ outlineOpen: open }),
  setMigrationAwaitingConfirm: (v) => set({ migrationAwaitingConfirm: v }),
  setBacklinksNodeId: (id) => set({ backlinksNodeId: id }),
  setBacklinksOpen: (open) => set({ backlinksOpen: open }),
  setOverviewOpen: (open) => set({ overviewOpen: open }),
  setSyncOpen: (open) => set({ syncOpen: open }),
  setCloseGuardOpen: (open) => set({ closeGuardOpen: open }),
  setBlockDeleteRequest: (req) => set({ blockDeleteRequest: req }),
  setQuotaDialog: (open, estimate = null) =>
    set({ quotaDialog: { open, estimate: estimate ?? null } }),
}));

/** 非 React 侧（快捷键 / 适配层）直接读最新 UI 态。 */
export function getWiringUi(): WiringUiState {
  return useWiringUi.getState();
}
