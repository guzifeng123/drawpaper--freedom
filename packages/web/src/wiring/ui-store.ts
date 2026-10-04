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

  setExportOpen(open: boolean): void;
  setSearchOpen(open: boolean): void;
  setActiveSearchIndex(i: number): void;
  bumpSnapshots(): void;
  bumpTrash(): void;
  setAiPanelOpen(open: boolean): void;
  setOutlineOpen(open: boolean): void;
}

export const useWiringUi = create<WiringUiState>((set) => ({
  exportOpen: false,
  searchOpen: false,
  activeSearchIndex: -1,
  snapshotsNonce: 0,
  trashNonce: 0,
  aiPanelOpen: false,
  outlineOpen: false,
  setExportOpen: (open) => set({ exportOpen: open }),
  setSearchOpen: (open) => set({ searchOpen: open }),
  setActiveSearchIndex: (i) => set({ activeSearchIndex: i }),
  bumpSnapshots: () => set((s) => ({ snapshotsNonce: s.snapshotsNonce + 1 })),
  bumpTrash: () => set((s) => ({ trashNonce: s.trashNonce + 1 })),
  setAiPanelOpen: (open) => set({ aiPanelOpen: open }),
  setOutlineOpen: (open) => set({ outlineOpen: open }),
}));

/** 非 React 侧（快捷键 / 适配层）直接读最新 UI 态。 */
export function getWiringUi(): WiringUiState {
  return useWiringUi.getState();
}
