import type { KBNoteDoc } from '../model/index.js';
import type { ClientId } from './identity.js';
import type { LamportClock, VersionVector, EventMarker } from './clock.js';
import { createLamportClock } from './clock.js';
import type { OpEnvelope } from './envelope.js';

/**
 * 协作态（CollabState）：doc 本体 + 协作元数据（字段时钟、墓碑、已应用 opId 表、op 日志）。
 *
 * 注意：
 * - doc 与 Dexie 持久化共用同一份对象（B 端负责落盘）；collab 元数据是运行态，
 *   不写进 .kbnote 文件。late-joiner 直接读 Dexie 拿 doc，再走 snapshot 对齐未落盘变更。
 * - 已落盘的历史没有字段时钟：createCollabState 把既有实体按 lamport=0、clientId='' 播种，
 *   即「任何后来的 op 都在其之上」——这是有意的近似，B 端可在 snapshot 对齐后重建时钟。
 */

/** 某个字段最后一次写入的定位 + 取值（字段级 LWW 的真相）。 */
export interface FieldClock {
  lamport: number;
  clientId: ClientId;
  /** 写入的值（快照，仅用于冲突报告；真正的值已落到 doc 里）。 */
  value: unknown;
}

/** 删除墓碑：删除带时间戳，晚到旧写入不复活。 */
export interface Tombstone {
  lamport: number;
  clientId: ClientId;
}

export interface EntityMeta {
  tombstone: Tombstone | null;
  /** 字段名 → 最后写入定位。 */
  fields: Record<string, FieldClock>;
}

/**
 * 寄存器型数组字段（tags / edge.points / page.pageBreaks）的并集元数据。
 *
 * 与标量字段的「整体 LWW 覆盖」不同：并发往同一寄存器加不同项应取并集（不互相覆盖），
 * 删除仍以墓碑为准——`removes` 记录每个 itemKey 的删除定位，晚于它的重新 add 才可复活
 * （标准 LWW-remove / OR-set 语义），早于它的旧 add 不复活，防止「并集导致删不掉」。
 *
 * key 形如 `${entity}:${entityId}:${field}`；entityId 对 page 级寄存器固定为 'page'。
 */
export interface RegisterMeta {
  /** itemKey → 最近一次 add 的定位（同 key 重复 add 走 LWW 刷新）。 */
  adds: Record<string, EventMarker>;
  /** itemKey → 删除墓碑定位；lamport 较大的 add 可复活。 */
  removes: Record<string, EventMarker>;
}

export interface CollabState {
  docId: string;
  doc: KBNoteDoc;
  /** 版本向量：每个 clientId 已应用到的最高 Lamport。 */
  vv: VersionVector;
  nodeMeta: Record<string, EntityMeta>;
  edgeMeta: Record<string, EntityMeta>;
  /** 文档级字段（title 等）的字段时钟。 */
  docFields: Record<string, FieldClock>;
  /** 分页设置字段时钟。 */
  pageFields: Record<string, FieldClock>;
  /** 寄存器并集元数据（tags / points / pageBreaks）。 */
  regMeta: Record<string, RegisterMeta>;
  /** 已应用 opId（去重幂等）；有界，由 pruneAppliedOps 裁剪。 */
  appliedOpIds: string[];
  /** 近期已应用 op 信封（供 snapshot 回给 late-joiner）；有界。 */
  log: OpEnvelope[];
  /** 本端逻辑时钟。 */
  clock: LamportClock;
}

function freshMeta(): EntityMeta {
  return { tombstone: null, fields: {} };
}

/** 寄存器 key 的统一拼装。 */
export function regKey(entity: 'node' | 'edge' | 'page', entityId: string, field: string): string {
  return `${entity}:${entityId}:${field}`;
}

/**
 * 用一份已有 doc（通常来自 Dexie 加载）建立协作态。
 * @param doc 已落盘文档
 * @param clock 可选注入时钟（默认从 0 开始）
 */
export function createCollabState(doc: KBNoteDoc, clock?: LamportClock): CollabState {
  const nodeMeta: Record<string, EntityMeta> = {};
  for (const n of doc.nodes) nodeMeta[n.id] = freshMeta();
  const edgeMeta: Record<string, EntityMeta> = {};
  for (const e of doc.edges) edgeMeta[e.id] = freshMeta();
  return {
    docId: doc.id,
    doc,
    vv: {},
    nodeMeta,
    edgeMeta,
    docFields: {},
    pageFields: {},
    regMeta: {},
    appliedOpIds: [],
    log: [],
    clock: clock ?? createLamportClock(0),
  };
}

/** opId 是否已应用过。 */
export function isOpApplied(state: CollabState, opId: string): boolean {
  return state.appliedOpIds.includes(opId);
}
