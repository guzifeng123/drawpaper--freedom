import { KBNoteDocSchema } from '../model/schema.js';
import { CollabProtocolError } from './envelope.js';
import type {
  CollabEnvelope,
  OpEnvelope,
  SnapshotEnvelope,
  SnapshotRequestEnvelope,
} from './envelope.js';
import type { CollabState } from './state.js';
import type { VersionVector } from './clock.js';
import { compareEvents, mergeVersions } from './clock.js';
import { applyOp } from './merge.js';
import type { ApplyResult } from './merge.js';
import type { CollabConflict } from './conflicts.js';

/**
 * Late-joiner 对齐：
 * 1. 新标签页打开 doc → 直接读 Dexie 拿已落盘 doc 建 CollabState；
 * 2. 广播 snapshot-request（带自己的版本向量）；
 * 3. 持有方回 snapshot = 基线 doc + baseVv + 基线之后的增量 op 列表；
 * 4. 请求方 applySnapshot：换基线 → 按确定性全序重放增量 op，opId 幂等跳过。
 *
 * 压缩（墓碑/opId 表有界化）：
 * - pruneTombstones：lamport ≤ watermark 的墓碑可丢弃（安全前提：所有对端 VV 已超过它）。
 * - pruneAppliedOps：只保留最近 keep 个 opId。
 */

/** 构造 snapshot-request 信封（header 由 B 端填好传入）。 */
export function buildSnapshotRequest(header: {
  docId: string;
  clientId: string;
  tabName: string;
  tabColor: string;
  lamport: number;
  requestVv: VersionVector;
}): SnapshotRequestEnvelope {
  return {
    v: 1,
    kind: 'snapshot-request',
    docId: header.docId,
    clientId: header.clientId,
    tabName: header.tabName,
    tabColor: header.tabColor,
    lamport: header.lamport,
    requestVv: { ...header.requestVv },
  };
}

/**
 * 持有方构造 snapshot 响应。
 * @param recentOps 本端日志中「晚于请求方 VV」的增量 op（B 端可直接传 state.log，内部再筛）。
 */
export function buildSnapshotResponse(header: {
  docId: string;
  clientId: string;
  tabName: string;
  tabColor: string;
  lamport: number;
  state: CollabState;
  requestVv: VersionVector;
}): SnapshotEnvelope {
  // 只回请求方还没见过的 op（粗略：op 发送方的 VV 分量 > 请求方对应分量）。
  const recentOps = header.state.log.filter((env) => {
    const seen = requestSees(env, header.requestVv);
    return !seen;
  });
  return {
    v: 1,
    kind: 'snapshot',
    docId: header.docId,
    clientId: header.clientId,
    tabName: header.tabName,
    tabColor: header.tabColor,
    lamport: header.lamport,
    snapshot: {
      baseline: header.state.doc,
      baseVv: { ...header.state.vv },
      ops: recentOps,
    },
  };
}

/** 请求方 VV 是否已覆盖该 op（按 op 作者分量判断）。 */
function requestSees(env: OpEnvelope, requestVv: VersionVector): boolean {
  const seenV = requestVv[env.clientId] ?? 0;
  return seenV >= env.lamport;
}

export interface SnapshotApplyResult {
  state: CollabState;
  conflicts: CollabConflict[];
  /** 重放的增量 op 数（含被幂等跳过的）。 */
  replayed: number;
}

/**
 * 应用一个 snapshot 响应：换基线 + 按确定性全序重放增量 op。
 * @throws CollabProtocolError 基线文档校验失败（坏消息不污染状态）。
 */
export function applySnapshot(
  current: CollabState,
  env: SnapshotEnvelope,
): SnapshotApplyResult {
  if (env.docId !== current.docId) {
    throw new CollabProtocolError('bad-envelope', `snapshot docId 不匹配：${env.docId} vs ${current.docId}`);
  }
  // 基线校验（zod），坏基线直接抛、不动 current。
  const baselineParsed = KBNoteDocSchema.safeParse(env.snapshot.baseline);
  if (!baselineParsed.success) {
    throw new CollabProtocolError(
      'bad-doc',
      `snapshot 基线文档校验失败（${baselineParsed.error.issues.length} 处）`,
      baselineParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }

  // 建立新基线态：保留本端时钟与 docId；VV 取「基线 VV 与本端 VV 的逐分量 max」，
  // 这样本端已发但基线未含的 op 不会被错误回退。
  let next: CollabState = {
    ...current,
    doc: baselineParsed.data as unknown as CollabState['doc'],
    nodeMeta: {},
    edgeMeta: {},
    docFields: {},
    pageFields: {},
    appliedOpIds: [],
    log: [],
    vv: mergeVersions(env.snapshot.baseVv, current.vv),
  };
  // 基线实体的字段时钟播种在「基线 lamport」：早于它的增量 op 自然输掉（基线已含其效果）。
  const baseLamport = env.lamport;
  for (const n of next.doc.nodes) {
    next.nodeMeta[n.id] = { tombstone: null, fields: seedBaselineFields(n, baseLamport, env.clientId) };
  }
  for (const e of next.doc.edges) {
    next.edgeMeta[e.id] = { tombstone: null, fields: seedBaselineEdgeFields(e, baseLamport, env.clientId) };
  }

  // 按确定性全序重放（lamport 升序；同 lamport clientId 小者排后=后写胜）。
  const ops = (env.snapshot.ops as OpEnvelope[])
    .filter((o): o is OpEnvelope => !!o && typeof o === 'object' && 'opId' in o && 'op' in o)
    .slice()
    .sort((a, b) => compareEvents({ lamport: a.lamport, clientId: a.clientId }, { lamport: b.lamport, clientId: b.clientId }));

  const conflicts: CollabConflict[] = [];
  for (const opEnv of ops) {
    const res: ApplyResult = applyOp(next, opEnv);
    next = res.state;
    conflicts.push(...res.conflicts);
  }
  return { state: next, conflicts, replayed: ops.length };
}

function seedBaselineFields(n: { id: string }, lamport: number, clientId: string) {
  void n;
  const fields: Record<string, { lamport: number; clientId: string; value: unknown }> = {};
  // 字段集合与 merge.seedNodeFields 对齐；value 留 undefined（冲突报告够用）。
  for (const k of ['x','y','width','height','content','parentId','pinned','locked','collapsed','tags','style','type','todo','image','heading','bookmark','attachment','reminder']) {
    fields[k] = { lamport, clientId, value: undefined };
  }
  return fields;
}

function seedBaselineEdgeFields(e: { id: string }, lamport: number, clientId: string) {
  void e;
  const fields: Record<string, { lamport: number; clientId: string; value: unknown }> = {};
  for (const k of ['source','target','sourceHandle','targetHandle','label','color','points']) {
    fields[k] = { lamport, clientId, value: undefined };
  }
  return fields;
}

// ---- 压缩 ----

/**
 * 丢弃 lamport ≤ watermark 的墓碑。
 * 安全前提（B 端保证）：watermark = 所有对端已确认的最小 VV 分量，
 * 即没有人还会再收到该墓碑之前的 op。
 */
export function pruneTombstones(state: CollabState, watermark: number): CollabState {
  const nodeMeta = pruneMap(state.nodeMeta, watermark);
  const edgeMeta = pruneMap(state.edgeMeta, watermark);
  return { ...state, nodeMeta, edgeMeta };
}

function pruneMap(
  map: CollabState['nodeMeta'],
  watermark: number,
): CollabState['nodeMeta'] {
  const out: CollabState['nodeMeta'] = {};
  for (const [id, meta] of Object.entries(map)) {
    if (meta.tombstone && meta.tombstone.lamport <= watermark) continue;
    out[id] = meta;
  }
  return out;
}

/** 只保留最近 keep 个已应用 opId（去重表有界化）。 */
export function pruneAppliedOps(state: CollabState, keep: number): CollabState {
  const appliedOpIds = keep <= 0 ? [] : state.appliedOpIds.slice(-keep);
  const log = keep <= 0 ? [] : state.log.slice(-keep);
  return { ...state, appliedOpIds, log };
}

/** 组合压缩：墓碑按 watermark、opId 表按 keep。 */
export function compactCollabState(
  state: CollabState,
  opts: { tombstoneWatermark: number; keepAppliedOps: number },
): CollabState {
  return pruneAppliedOps(pruneTombstones(state, opts.tombstoneWatermark), opts.keepAppliedOps);
}

/** 类型守卫：是不是 snapshot 信封。 */
export function isSnapshotEnvelope(env: CollabEnvelope): env is SnapshotEnvelope {
  return env.kind === 'snapshot';
}
