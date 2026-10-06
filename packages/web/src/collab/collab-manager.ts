import {
  createCollabState,
  applyOp,
  applySnapshot,
  buildSnapshotRequest,
  buildSnapshotResponse,
  compactCollabState,
  createLamportClock,
  createTabIdentity,
  nextOpId,
  COLLAB_PROTOCOL_VERSION,
  CollabProtocolError,
  summarizeConflicts,
  type CollabState,
  type ClientId,
  type TabIdentity,
  type OpEnvelope,
  type PresenceEnvelope,
  type SnapshotEnvelope,
  type SnapshotRequestEnvelope,
  type CollabEnvelope,
  type EnvelopeHeader,
  type LamportClock,
  type VersionVector,
} from '@drawpaper/core';
import { editorStore } from '@/store/editor-store';
import type { KBNoteDoc } from '@drawpaper/core';
import { createTransport, SITE_CHANNEL, docChannel, type CollabTransport } from './transport';
import { diffDocOps } from './doc-diff';
import {
  upsertPeer,
  sweepOfflinePeers,
  peersForDoc,
  docsOpenByPeers,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_PRESENCE_TIMEOUT_MS,
  type Peer,
} from './presence-peers';
import { useCollabUi } from './collab-ui-store';

/**
 * CollabManager：同浏览器多标签协作的 web 编排单例。
 *
 * 职责：
 *  - 标签身份（sessionStorage 稳定 clientId；可编辑名称；颜色）
 *  - Lamport 时钟随本地命令 tick、随远端消息 observe
 *  - 监听 editorStore 本地变更 → diffDocOps 转 op → 广播 → 喂回本地 CollabState 元数据
 *  - 远端 op：合并前拍快照 → applyOp → 按 outcome 落库（applyRemoteDoc，不进 undo/不回广播）
 *  - late-joiner：开文档即发 snapshot-request；持方回 snapshot；applySnapshot 对齐
 *  - peers 版本向量表 + 心跳超时清扫 + 定期 compact
 *
 * 铁律：全程 BroadcastChannel/storage 进程内闭环，零网络流量；core 纯函数零 DOM。
 */

const IDENTITY_KEY = 'drawpaper-collab:v1:identity';
const PRE_MERGE_SNAPSHOT_THROTTLE_MS = 2500;
const COMPACT_INTERVAL_MS = 10_000;
const KEEP_APPLIED_OPS = 200;

function loadOrCreateIdentity(): TabIdentity {
  try {
    const raw = sessionStorage.getItem(IDENTITY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as TabIdentity;
      if (parsed && typeof parsed.clientId === 'string' && parsed.clientId.startsWith('c_')) {
        return parsed;
      }
    }
  } catch {
    /* sessionStorage 不可用：每次新建 */
  }
  // 用当前标签数（粗略）做 seed，尽量错开颜色。
  const seed = (window.name ? window.name.length : 0) + (sessionStorage.length || 0);
  const id = createTabIdentity(undefined, { seed });
  try {
    sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(id));
  } catch {
    /* 忽略 */
  }
  return id;
}

export class CollabManager {
  private identity: TabIdentity;
  private clock: LamportClock;
  private state: CollabState | null = null;
  private docId: string | null = null;
  private siteTransport: CollabTransport;
  private docTransport: CollabTransport | null = null;
  private unsubscribe: (() => void) | null = null;
  private applyingRemote = 0;
  private peers = new Map<ClientId, Peer>();
  private alignedForDoc = new Set<string>();
  private heartbeatSeq = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private compactTimer: ReturnType<typeof setInterval> | null = null;
  private lastPreMergeSnapshotAt = 0;
  private installed = false;
  private now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.identity = typeof window !== 'undefined' ? loadOrCreateIdentity() : createTabIdentity();
    this.clock = createLamportClock(0);
    this.siteTransport = createTransport(SITE_CHANNEL);
    useCollabUi.getState().setIdentity(this.identity);
    useCollabUi.getState().setTransportKind(this.siteTransport.kind);
  }

  /** 本端 clientId（dev-hooks 检视用）。 */
  get clientId(): ClientId {
    return this.identity.clientId;
  }

  get transportKind() {
    return this.siteTransport.kind;
  }

  /** 当前协作态的轻量检视（dev-hooks / 测试）。 */
  inspect() {
    return {
      clientId: this.identity.clientId,
      tabName: this.identity.name,
      tabColor: this.identity.color,
      transport: this.transportKind,
      docId: this.docId,
      lamport: this.clock.value,
      peerCount: this.peers.size,
      peerIds: [...this.peers.keys()],
      appliedOpCount: this.state?.appliedOpIds.length ?? 0,
      logLength: this.state?.log.length ?? 0,
      vv: this.state ? { ...this.state.vv } : {},
      aligned: this.docId ? this.alignedForDoc.has(this.docId) : false,
    };
  }

  /** 用户改标签页名（立即持久化并在下一次心跳广播）。 */
  renameTab(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.identity = { ...this.identity, name: trimmed };
    try {
      sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(this.identity));
    } catch {
      /* ignore */
    }
    useCollabUi.getState().setIdentity(this.identity);
  }

  install(): void {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;

    this.siteTransport.onMessage((env) => this.routeSite(env));

    // 订阅 store：本地变更广播 + docId 切换重建会话。
    this.unsubscribe = editorStore.subscribe((state, prev) => {
      if (state.currentDocId !== prev.currentDocId) {
        this.setupSession(state.currentDocId);
        return;
      }
      if (this.applyingRemote > 0) return;
      if (state.doc !== prev.doc && this.docId === state.currentDocId) {
        this.onLocalDocChanged(prev.doc, state.doc);
      }
    });

    // 初始会话（bootstrap 可能已打开文档）。
    this.setupSession(editorStore.getState().currentDocId);

    // 心跳 + 清扫 + 压缩。
    this.heartbeatTimer = setInterval(() => this.sendPresence(), DEFAULT_HEARTBEAT_MS);
    this.sweepTimer = setInterval(() => this.sweep(), 1000);
    this.compactTimer = setInterval(() => this.compact(), COMPACT_INTERVAL_MS);

    useCollabUi.getState().setReady(true);
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.docTransport?.close();
    this.docTransport = null;
    this.siteTransport.close();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.compactTimer) clearInterval(this.compactTimer);
  }

  // ---------------- 会话生命周期 ----------------

  private header(docId: string, lamport: number): EnvelopeHeader {
    return {
      v: COLLAB_PROTOCOL_VERSION,
      docId,
      clientId: this.identity.clientId,
      tabName: this.identity.name,
      tabColor: this.identity.color,
      lamport,
    };
  }

  private setupSession(docId: string): void {
    this.docTransport?.close();
    this.docTransport = null;
    this.state = null;
    this.docId = docId;
    this.alignedForDoc.delete(docId);

    const doc = editorStore.getState().doc;
    this.state = createCollabState(doc, this.clock);

    this.docTransport = createTransport(docChannel(docId));
    this.docTransport.onMessage((env) => {
      if (env.kind === 'op') this.onRemoteOp(env);
    });

    this.publishPeers();

    // late-joiner：请求对齐（已落盘 doc 为基线，快照只补未落盘增量）。
    if (this.transportKind !== 'disabled') {
      const lamport = this.clock.tick();
      const req = buildSnapshotRequest({
        docId,
        clientId: this.identity.clientId,
        tabName: this.identity.name,
        tabColor: this.identity.color,
        lamport,
        requestVv: { ...this.state.vv },
      });
      this.siteTransport.send(req);
    }
  }

  // ---------------- 本地变更 → op 广播 ----------------

  private onLocalDocChanged(prev: KBNoteDoc, next: KBNoteDoc): void {
    if (!this.state) return;
    const ops = diffDocOps(prev, next);
    for (const op of ops) {
      const lamport = this.clock.tick();
      const env: OpEnvelope = {
        ...this.header(this.docId!, lamport),
        kind: 'op',
        opId: nextOpId(),
        op,
      };
      this.docTransport?.send(env);
      // 喂回本地合并引擎：只取元数据（字段时钟/vv/log/opId），doc 仍以命令管道产物为准。
      const res = applyOp(this.state, env);
      this.state = { ...res.state, doc: next };
    }
  }

  // ---------------- 远端消息路由 ----------------

  private routeSite(env: CollabEnvelope): void {
    switch (env.kind) {
      case 'presence':
        this.onPresence(env);
        break;
      case 'snapshot-request':
        this.onSnapshotRequest(env);
        break;
      case 'snapshot':
        this.onSnapshot(env);
        break;
      case 'op':
        // op 走 doc channel；站点通道上收到也按 docId 过滤后处理。
        if (env.docId === this.docId) this.onRemoteOp(env);
        break;
    }
  }

  private onPresence(env: PresenceEnvelope): void {
    if (env.clientId === this.identity.clientId) return;
    this.clock.observe(env.lamport);
    this.peers = upsertPeer(this.peers, {
      clientId: env.clientId,
      name: env.tabName,
      color: env.tabColor,
      presence: env.presence,
      now: this.now(),
    });
    this.publishPeers();
  }

  private onSnapshotRequest(env: SnapshotRequestEnvelope): void {
    if (!this.state || env.docId !== this.docId) return;
    if (env.clientId === this.identity.clientId) return;
    this.clock.observe(env.lamport);
    const resp = buildSnapshotResponse({
      docId: env.docId,
      clientId: this.identity.clientId,
      tabName: this.identity.name,
      tabColor: this.identity.color,
      lamport: this.clock.observe(env.lamport),
      state: this.state,
      requestVv: env.requestVv,
    });
    this.siteTransport.send(resp);
  }

  private onSnapshot(env: SnapshotEnvelope): void {
    if (!this.state || env.docId !== this.docId) return;
    if (env.clientId === this.identity.clientId) return;
    if (this.alignedForDoc.has(this.docId)) return; // 已对齐，忽略后续快照
    this.clock.observe(env.lamport);
    try {
      const res = applySnapshot(this.state, env);
      this.state = res.state;
      this.alignedForDoc.add(this.docId);
      this.applyingRemote++;
      editorStore.getState().applyRemoteDoc(this.state.doc);
      this.applyingRemote--;
      if (res.conflicts.length > 0) {
        useCollabUi.getState().pushConflicts(res.conflicts);
      }
    } catch (e) {
      if (e instanceof CollabProtocolError) return; // 坏基线丢弃
      throw e;
    }
  }

  private onRemoteOp(env: OpEnvelope): void {
    if (!this.state) return;
    if (env.docId !== this.docId) return;
    if (env.clientId === this.identity.clientId) return;
    this.clock.observe(env.lamport);
    // 合并前快照（节流）：供「回滚到合并前」。
    void this.maybeSnapshotBeforeMerge();
    const res = applyOp(this.state, env);
    this.state = res.state;
    if (res.outcome === 'applied') {
      this.applyingRemote++;
      editorStore.getState().applyRemoteDoc(this.state.doc);
      this.applyingRemote--;
      if (res.conflicts.length > 0) {
        useCollabUi.getState().pushConflicts(res.conflicts);
      }
    }
  }

  private maybeSnapshotBeforeMerge(): void {
    const t = this.now();
    if (t - this.lastPreMergeSnapshotAt < PRE_MERGE_SNAPSHOT_THROTTLE_MS) return;
    this.lastPreMergeSnapshotAt = t;
    void editorStore.getState().snapshotDoc('协作合并前');
  }

  // ---------------- presence 心跳 / 清扫 / 压缩 ----------------

  private sendPresence(): void {
    if (this.transportKind === 'disabled' || !this.docId) return;
    const s = editorStore.getState();
    this.heartbeatSeq += 1;
    const lamport = this.clock.tick();
    const env: PresenceEnvelope = {
      ...this.header(this.docId, lamport),
      kind: 'presence',
      presence: {
        docId: this.docId,
        selection: [...s.selection],
        hoverNodeId: null,
        blockRect: null,
        heartbeatSeq: this.heartbeatSeq,
      },
    };
    this.siteTransport.send(env);
  }

  private sweep(): void {
    const { table, removed } = sweepOfflinePeers(this.peers, this.now(), DEFAULT_PRESENCE_TIMEOUT_MS);
    if (removed.length > 0 || table.size !== this.peers.size) {
      this.peers = table;
      this.publishPeers();
    }
  }

  private publishPeers(): void {
    const docId = this.docId;
    const forDoc = docId ? peersForDoc(this.peers, docId) : [];
    useCollabUi.getState().setPeers(forDoc);
    const byDoc = docsOpenByPeers(this.peers);
    const obj: Record<string, Array<{ clientId: ClientId; name: string; color: string }>> = {};
    for (const [d, arr] of byDoc) obj[d] = arr;
    useCollabUi.getState().setDocsOpenedElsewhere(obj);
  }

  private compact(): void {
    if (!this.state) return;
    // watermark：本端时钟往前留余量；peers VV 暂以本端 lamport 为粗水位（单浏览器场景足够）。
    const watermark = Math.max(0, this.clock.value - KEEP_APPLIED_OPS);
    this.state = compactCollabState(this.state, {
      tombstoneWatermark: watermark,
      keepAppliedOps: KEEP_APPLIED_OPS,
    });
  }

  /** 冲突中文摘要（UI 横幅用；dev-hooks 也可调用）。 */
  conflictSummary(): string[] {
    const names = new Map<ClientId, string>();
    for (const p of this.peers.values()) names.set(p.clientId, p.name);
    names.set(this.identity.clientId, this.identity.name);
    return summarizeConflicts(useCollabUi.getState().conflicts, names);
  }
}

/** 全局单例（App 启动时 install 一次）。 */
export const collabManager = new CollabManager();

export type { VersionVector };
