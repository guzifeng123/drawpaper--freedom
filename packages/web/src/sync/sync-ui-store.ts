import { create } from 'zustand';
import { listConflictCopies } from './sync-db';

/**
 * 同步 UI 态（zustand，非持久化、不进 undo 栈）。
 * 设置→同步面板与同步冲突横幅订阅这里；真相在 orchestrator/channel。
 */

export type SyncChannelType = 'none' | 'folder' | 'webdav' | 'manual';

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
  /** WebDAV 同步配置中是否开启了端到端加密（持久化配置的镜像）。 */
  e2eeEnabled: boolean;
  /** 已配置加密但口令尚未解锁（刷新后待输入）：面板弹解锁框。 */
  e2eeLocked: boolean;
  /** 当前通道是否真的带加密上线（与 e2eeEnabled 区分：配置开但未解锁时为 false）。 */
  e2eeActive: boolean;
  /** 待处理冲突副本数（三来源聚合，冲突面板徽标用）。 */
  conflictCopiesCount: number;
  /** 冲突副本面板是否打开。 */
  conflictPanelOpen: boolean;
  /** 手动备份包导入/导出进行中（禁用按钮）。 */
  bundleBusy: boolean;

  setChannel(c: SyncChannelType): void;
  setBusy(b: boolean): void;
  setLastSyncAt(t: number): void;
  bumpCounts(push: number, pull: number): void;
  setConflicts(conflicts: string[]): void;
  clearConflicts(): void;
  setError(err: string): void;
  setTargetLabel(label: string): void;
  setE2eeEnabled(b: boolean): void;
  setE2eeLocked(b: boolean): void;
  setE2eeActive(b: boolean): void;
  setConflictCopiesCount(n: number): void;
  setConflictPanelOpen(b: boolean): void;
  setBundleBusy(b: boolean): void;
  refreshConflictCopies(): Promise<void>;
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
  e2eeEnabled: false,
  e2eeLocked: false,
  e2eeActive: false,
  conflictCopiesCount: 0,
  conflictPanelOpen: false,
  bundleBusy: false,

  setChannel: (channel) => set({ channel }),
  setBusy: (busy) => set({ busy }),
  setLastSyncAt: (lastSyncAt) => set({ lastSyncAt }),
  bumpCounts: (push, pull) =>
    set((s) => ({ pushCount: s.pushCount + push, pullCount: s.pullCount + pull })),
  setConflicts: (conflicts) => set({ conflicts, conflictCount: conflicts.length }),
  clearConflicts: () => set({ conflicts: [], conflictCount: 0 }),
  setError: (error) => set({ error }),
  setTargetLabel: (targetLabel) => set({ targetLabel }),
  setE2eeEnabled: (e2eeEnabled) => set({ e2eeEnabled }),
  setE2eeLocked: (e2eeLocked) => set({ e2eeLocked }),
  setE2eeActive: (e2eeActive) => set({ e2eeActive }),
  setConflictCopiesCount: (conflictCopiesCount) => set({ conflictCopiesCount }),
  setConflictPanelOpen: (conflictPanelOpen) => set({ conflictPanelOpen }),
  setBundleBusy: (bundleBusy) => set({ bundleBusy }),
  refreshConflictCopies: async () => {
    const rows = await listConflictCopies();
    set({ conflictCopiesCount: rows.length });
  },
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
      e2eeEnabled: false,
      e2eeLocked: false,
      e2eeActive: false,
      conflictCopiesCount: 0,
      conflictPanelOpen: false,
      bundleBusy: false,
    }),
}));
