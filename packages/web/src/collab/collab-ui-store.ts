import { create } from 'zustand';
import type { CollabConflict, ClientId, TabIdentity } from '@drawpaper/core';
import type { CollabTransportKind } from './transport';
import type { Peer } from './presence-peers';

/**
 * 协作 UI 态（zustand，非持久化、不进 undo 栈）：
 *  - 本端身份 / 传输模式（在线点与降级提示用）
 *  - 远端 peer 表（在线点 / 远端选区高亮）
 *  - 分叉冲突列表（顶部横幅 + 可展开列表）
 *  - 站点级「文档 → 他标签打开」映射（文档列表咨询标记）
 *
 * 这些是「视图模型」：真相在 CollabManager；这里只放 React 需要订阅的最小切片。
 */

export interface CollabUiState {
  /** 本端身份（clientId 稳定；name 可编辑并广播）。 */
  identity: TabIdentity | null;
  /** 实际生效的传输（disabled = 单标签降级）。 */
  transportKind: CollabTransportKind;
  /** 是否有对端在线（用于在线点聚合显示）。 */
  peerCount: number;
  /** 远端 peer 表（只含其他标签）。 */
  peers: Peer[];
  /** 当前文档未解决的并发冲突（败方记录；非空 → 顶部横幅）。 */
  conflicts: CollabConflict[];
  /** 冲突横幅是否展开（看完整列表）。 */
  conflictsExpanded: boolean;
  /** 站点级：docId → 正在打开它的远端 peer 摘要。 */
  docsOpenedElsewhere: Record<string, Array<{ clientId: ClientId; name: string; color: string }>>;
  /** 协作模块是否已就绪（已挂载并完成首包对齐）。 */
  ready: boolean;

  setIdentity(identity: TabIdentity): void;
  setTransportKind(kind: CollabTransportKind): void;
  setPeers(peers: Peer[]): void;
  pushConflicts(conflicts: CollabConflict[]): void;
  clearConflicts(): void;
  setConflictsExpanded(on: boolean): void;
  setDocsOpenedElsewhere(map: Record<string, Array<{ clientId: ClientId; name: string; color: string }>>): void;
  setReady(on: boolean): void;
  renameIdentity(name: string): void;
}

export const useCollabUi = create<CollabUiState>((set) => ({
  identity: null,
  transportKind: 'disabled',
  peerCount: 0,
  peers: [],
  conflicts: [],
  conflictsExpanded: false,
  docsOpenedElsewhere: {},
  ready: false,

  setIdentity: (identity) => set({ identity }),
  setTransportKind: (kind) => set({ transportKind: kind }),
  setPeers: (peers) => set({ peers, peerCount: peers.length }),
  pushConflicts: (conflicts) =>
    set((s) => ({ conflicts: [...s.conflicts, ...conflicts], conflictsExpanded: true })),
  clearConflicts: () => set({ conflicts: [], conflictsExpanded: false }),
  setConflictsExpanded: (on) => set({ conflictsExpanded: on }),
  setDocsOpenedElsewhere: (map) => set({ docsOpenedElsewhere: map }),
  setReady: (on) => set({ ready: on }),
  renameIdentity: (name) =>
    set((s) => (s.identity ? { identity: { ...s.identity, name: name.trim() || s.identity.name } } : s)),
}));
