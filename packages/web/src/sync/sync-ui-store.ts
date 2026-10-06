import { create } from 'zustand';

/**
 * 同步 UI 态（zustand，非持久化、不进 undo 栈）。
 * 设置→同步面板与同步冲突横幅订阅这里；真相在 orchestrator/channel。
 */

export type SyncChannelType = 'none' | 'folder' | 'webdav';

export interface SyncUiState {
  /** 当前配置的通道类型（互斥：同时只配一个）。 */
  channel: SyncChannelType;
  /** 正在同步中（禁用按钮）。 */
  busy: boolean;
  /** 上次同步完成时间（epoch ms）；未同步过为 null。 */
  lastSyncAt: number | null;
  /** 累计推/拉文档数。 */
  pushCount: number;
  pullCount: number;
  /** 待解决冲突数。 */
  conflictCount: number;
  /** 同步冲突中文摘要（横幅渲染；复用 mergeSnapshots().summary 形状）。 */
  conflicts: string[];
  /** 最近一次错误文案（toast/面板展示；空串=无）。 */
  error: string;
  /** 同步目录名 / WebDAV 主机名（展示用）。 */
  targetLabel: string;

  setChannel(c: SyncChannelType): void;
  setBusy(b: boolean): void;
  setLastSyncAt(t: number): void;
  bumpCounts(push: number, pull: number): void;
  setConflicts(conflicts: string[]): void;
  clearConflicts(): void;
  setError(err: string): void;
  setTargetLabel(label: string): void;
  reset(): void;
}

export const useSyncUi = create<SyncUiState>((set) => ({
  channel: 'none',
  busy: false,
  lastSyncAt: null,
  pushCount: 0,
  pullCount: 0,
  conflictCount: 0,
  conflicts: [],
  error: '',
  targetLabel: '',

  setChannel: (channel) => set({ channel }),
  setBusy: (busy) => set({ busy }),
  setLastSyncAt: (lastSyncAt) => set({ lastSyncAt }),
  bumpCounts: (push, pull) =>
    set((s) => ({ pushCount: s.pushCount + push, pullCount: s.pullCount + pull })),
  setConflicts: (conflicts) => set({ conflicts, conflictCount: conflicts.length }),
  clearConflicts: () => set({ conflicts: [], conflictCount: 0 }),
  setError: (error) => set({ error }),
  setTargetLabel: (targetLabel) => set({ targetLabel }),
  reset: () =>
    set({
      channel: 'none',
      busy: false,
      lastSyncAt: null,
      pushCount: 0,
      pullCount: 0,
      conflictCount: 0,
      conflicts: [],
      error: '',
      targetLabel: '',
    }),
}));
