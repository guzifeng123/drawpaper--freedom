import type { KBNoteDoc, BlockNode, Edge, CollabOp } from '@drawpaper/core';
import { maxPersistedLamport, type FMarkTuple, type SyncBlock } from '@drawpaper/core';
import { diffDocOps } from '@/collab/doc-diff';
import { loadOrCreateDeviceClientId } from './device-identity';

/**
 * v3 落盘盖章层（Wave10 阶段 B，契约 §5.4）。
 *
 * 本地每条命令经 core 命令管道改 doc；本层在 web 侧「命令后差量盖章」：
 * 订阅 editorStore，对本地变更做 diffDocOps 差量，为被改字段打
 * `[lamport, deviceClientId]` 戳，并在落盘（Dexie saveDoc）时把戳合并进 doc.sync。
 *
 * 设计要点：
 * - 不改 core 命令语义；core 零改动。
 * - 盖章在「落盘边界」写进 doc.sync（包装 DexieStorageAdapter.saveDoc），
 *   内存里的编辑态 doc 不必带戳（编辑态每帧重建，戳随持久化进入 .kbnote）。
 * - 盖章累加器按 docId 单调增长，落盘时整体 overlay，天然幂等、不丢历史戳。
 * - 远端合并（applyRemoteDoc）与文档切换（openDoc）不盖章：分别由 applyingRemote
 *   计数与 currentDocId 变化识别。
 * - 时钟：打开文档后先 adoptClockFloor 抬到 maxPersistedLamport，再 tick，
 *   保证本地新戳严格大于任何已持久化事件（含 v2→v3 迁移戳）。
 *
 * 零网络 / 零新依赖。
 */

/** 单文档的本端盖章累加器（单调；overlay 时整体合并）。 */
interface DocStampAccumulator {
  /** 本端对该文档已盖到的最高 lamport。 */
  vv: number;
  docF: Record<string, FMarkTuple>;
  pageF: Record<string, FMarkTuple>;
  /** nodeId → field → mark。 */
  nodeF: Record<string, Record<string, FMarkTuple>>;
  /** nodeId → 墓碑 mark（删除优先）。 */
  nodeTomb: Record<string, FMarkTuple>;
  edgeF: Record<string, Record<string, FMarkTuple>>;
  edgeTomb: Record<string, FMarkTuple>;
}

function emptyAcc(): DocStampAccumulator {
  return { vv: 0, docF: {}, pageF: {}, nodeF: {}, nodeTomb: {}, edgeF: {}, edgeTomb: {} };
}

/** 节点上参与字段级 LWW 的字段（与 core NODE_CLOCKED_FIELDS 对齐）。 */
const NODE_CLOCKED = new Set([
  'x', 'y', 'width', 'height', 'content', 'parentId',
  'pinned', 'locked', 'collapsed', 'tags', 'style', 'type',
  'todo', 'image', 'heading', 'bookmark', 'attachment', 'reminder',
]);
/** 边上参与字段级 LWW 的字段（color 在节点本体上是 edge.style.color）。 */
const EDGE_CLOCKED = new Set([
  'source', 'target', 'sourceHandle', 'targetHandle', 'label', 'color', 'points',
]);

export class SyncStamper {
  readonly clientId: string;
  private clock = 0;
  private acc = new Map<string, DocStampAccumulator>();
  /** 远端合并正在落库期间，本地 diff 不盖章。 */
  applyingRemote = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(clientId?: string) {
    this.clientId = clientId ?? loadOrCreateDeviceClientId();
  }

  /** 本端当前 Lamport 水位（dev-hooks 检视 / 测试用）。 */
  get lamport(): number {
    return this.clock;
  }

  /** 订阅 editorStore。install 一次。 */
  install(store: { subscribe: (fn: (s: unknown, p: unknown) => void) => () => void; getState: () => { currentDocId: string; doc: KBNoteDoc } }): void {
    if (this.unsubscribe) return;
    // 初始文档：先抬时钟到 floor。
    this.adoptFloor(store.getState().doc);
    this.unsubscribe = store.subscribe((stateRaw, prevRaw) => {
      const state = stateRaw as { currentDocId: string; doc: KBNoteDoc };
      const prev = prevRaw as { currentDocId: string; doc: KBNoteDoc };
      // 文档切换：抬时钟到新文档 floor，并跳过本次切换本身的 diff。
      if (state.currentDocId !== prev.currentDocId) {
        this.adoptFloor(state.doc);
        return;
      }
      if (this.applyingRemote > 0) return;
      if (state.doc === prev.doc) return;
      this.onLocalDocChanged(prev.doc, state.doc);
    });
  }

  /** 抬时钟到文档已持久化的最高 lamport（加载 v3 后必做）。 */
  adoptFloor(doc: KBNoteDoc): void {
    const floor = maxPersistedLamport(doc);
    if (floor > this.clock) this.clock = floor;
  }

  beginRemoteApply(): void {
    this.applyingRemote += 1;
  }

  /** 远端合并落库后：合并结果即新基线，清空该文档累加器并把时钟抬到合并后 floor。 */
  endRemoteApply(doc: KBNoteDoc): void {
    this.applyingRemote = Math.max(0, this.applyingRemote - 1);
    this.acc.delete(doc.id);
    this.adoptFloor(doc);
  }

  /** 测试用：清空累加器与时钟。 */
  resetForTest(): void {
    this.acc.clear();
    this.clock = 0;
    this.applyingRemote = 0;
  }

  // ---------------- 本地差量 → 盖章 ----------------

  private tick(): number {
    this.clock += 1;
    return this.clock;
  }

  private onLocalDocChanged(prev: KBNoteDoc, next: KBNoteDoc): void {
    if (prev.id !== next.id) return;
    const ops = diffDocOps(prev, next);
    if (ops.length === 0) return;
    const acc = this.ensure(next.id);
    for (const op of ops) this.applyOp(acc, op);
  }

  private ensure(docId: string): DocStampAccumulator {
    let a = this.acc.get(docId);
    if (!a) {
      a = emptyAcc();
      this.acc.set(docId, a);
    }
    return a;
  }

  private bump(acc: DocStampAccumulator): void {
    const l = this.tick();
    if (l > acc.vv) acc.vv = l;
  }

  private stampNodeField(acc: DocStampAccumulator, nodeId: string, field: string): void {
    const l = this.tick();
    if (l > acc.vv) acc.vv = l;
    const fields = (acc.nodeF[nodeId] ??= {});
    fields[field] = [l, this.clientId];
  }

  private stampEdgeField(acc: DocStampAccumulator, edgeId: string, field: string): void {
    const l = this.tick();
    if (l > acc.vv) acc.vv = l;
    const fields = (acc.edgeF[edgeId] ??= {});
    fields[field] = [l, this.clientId];
  }

  private applyOp(acc: DocStampAccumulator, op: CollabOp): void {
    switch (op.kind) {
      case 'add-node': {
        // 新建节点：把该节点上所有时钟化字段一次性盖戳。
        const n = op.node as BlockNode;
        for (const f of NODE_CLOCKED) {
          if ((n as unknown as Record<string, unknown>)[f] !== undefined) this.stampNodeField(acc, n.id, f);
        }
        break;
      }
      case 'update-node': {
        for (const f of Object.keys(op.patch ?? {})) {
          if (NODE_CLOCKED.has(f)) this.stampNodeField(acc, op.nodeId, f);
        }
        break;
      }
      case 'delete-nodes': {
        for (const id of op.nodeIds) {
          this.bump(acc);
          acc.nodeTomb[id] = [this.clock, this.clientId];
        }
        break;
      }
      case 'add-edge': {
        const e = op.edge as Edge;
        for (const f of EDGE_CLOCKED) {
          if (f === 'color') this.stampEdgeField(acc, e.id, 'color');
          else if ((e as unknown as Record<string, unknown>)[f] !== undefined) this.stampEdgeField(acc, e.id, f);
        }
        break;
      }
      case 'update-edge': {
        for (const f of Object.keys(op.patch ?? {})) {
          if (EDGE_CLOCKED.has(f)) this.stampEdgeField(acc, op.edgeId, f);
        }
        break;
      }
      case 'delete-edge': {
        this.bump(acc);
        acc.edgeTomb[op.edgeId] = [this.clock, this.clientId];
        break;
      }
      case 'set-doc-meta': {
        for (const f of Object.keys(op.patch ?? {})) {
          if (f === 'title') {
            const l = this.tick();
            if (l > acc.vv) acc.vv = l;
            acc.docF[f] = [l, this.clientId];
          }
        }
        break;
      }
      case 'set-page': {
        for (const f of Object.keys(op.patch ?? {})) {
          const l = this.tick();
          if (l > acc.vv) acc.vv = l;
          acc.pageF[f] = [l, this.clientId];
        }
        break;
      }
      default:
        break;
    }
  }

  // ---------------- 落盘 / 导出时盖章 ----------------

  /**
   * 把累加器 overlay 进 doc.sync。无累加器时原样返回（零开销快路径）。
   * 导出与落盘共用：保证写出的 .kbnote 带本端真实 clientId+递增 lamport 戳。
   */
  stampForPersist<T extends KBNoteDoc>(doc: T): T {
    const acc = this.acc.get(doc.id);
    if (!acc) return doc;
    return applyAccumulator(doc, acc, this.clientId) as T;
  }

  /** 某文档是否有尚未落盘的本端盖章（dev-hooks / 测试用）。 */
  hasPendingStamps(docId: string): boolean {
    const a = this.acc.get(docId);
    return !!a && a.vv > 0;
  }

  /**
   * 包装一个 StorageAdapter.saveDoc：落盘前盖章。
   * 返回被包装的同一对象（就地改 saveDoc 方法）。
   */
  wrapSaveDoc<T extends { saveDoc: (doc: KBNoteDoc) => Promise<void> }>(adapter: T): T {
    const orig = adapter.saveDoc.bind(adapter);
    adapter.saveDoc = async (doc: KBNoteDoc) => {
      await orig(this.stampForPersist(doc));
    };
    return adapter;
  }
}

/**
 * 纯函数：把累加器 overlay 到一份 doc 的 sync 块。
 * - vv[clientId] = max(旧, acc.vv)；
 * - docF/pageF 合并；
 * - nodes/edges 字段戳合并，墓碑（t）优先覆盖字段戳。
 * 抽出便于单测（不依赖 store）。
 */
export function applyAccumulator(doc: KBNoteDoc, acc: DocStampAccumulator, clientId: string): KBNoteDoc {
  const base: SyncBlock = doc.sync ?? { vv: {} };
  const nodes: Record<string, { f?: Record<string, FMarkTuple>; t?: FMarkTuple }> = { ...(base.nodes ?? {}) };
  for (const [nodeId, fields] of Object.entries(acc.nodeF)) {
    const meta = { ...(nodes[nodeId] ?? {}) };
    meta.f = { ...(meta.f ?? {}), ...fields };
    nodes[nodeId] = meta;
  }
  for (const [nodeId, tomb] of Object.entries(acc.nodeTomb)) {
    nodes[nodeId] = { t: tomb };
  }
  const edges: Record<string, { f?: Record<string, FMarkTuple>; t?: FMarkTuple }> = { ...(base.edges ?? {}) };
  for (const [edgeId, fields] of Object.entries(acc.edgeF)) {
    const meta = { ...(edges[edgeId] ?? {}) };
    meta.f = { ...(meta.f ?? {}), ...fields };
    edges[edgeId] = meta;
  }
  for (const [edgeId, tomb] of Object.entries(acc.edgeTomb)) {
    edges[edgeId] = { t: tomb };
  }
  const vv = { ...(base.vv ?? {}) };
  vv[clientId] = Math.max(vv[clientId] ?? 0, acc.vv);

  const out: KBNoteDoc = {
    ...doc,
    sync: {
      vv,
      docF: { ...(base.docF ?? {}), ...acc.docF },
      pageF: { ...(base.pageF ?? {}), ...acc.pageF },
      nodes,
      edges,
    },
  };
  return out;
}

/** 全局单例（App/main 安装一次）。 */
export const syncStamper = new SyncStamper();
