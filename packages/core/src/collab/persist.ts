import type { KBNoteDoc } from '../model/index.js';
import type { ClientId } from './identity.js';
import type { VersionVector } from './clock.js';
import { createLamportClock } from './clock.js';
import type { OpEnvelope } from './envelope.js';
import type { CollabState, EntityMeta, RegisterMeta } from './state.js';
import { createCollabState } from './state.js';

/**
 * CollabState 运行时元数据的持久化序列化（纯函数，零宿主 API）。
 *
 * 落点设计（见 docs/wave14/touch-collab-persist.md）：
 * - 只序列化「协作元数据」（版本向量 / 各实体字段时钟 / 寄存器并集墓碑 / 已应用 opId /
 *   近期 op 日志 / 本端时钟水位），**不序列化 doc 本体**——doc 仍由文档主存储通道
 *   （Dexie docs 表 / .kbnote）负责，二者解耦。
 * - 这是「同浏览器 collab 元数据」，与 schema v3 跨设备同步的 doc.sync.vv 是两套独立水位：
 *   本结构存独立 IndexedDB 库（见 web 侧 collab-persist.ts），绝不写进 .kbnote / sync 契约，
 *   因此不会污染跨设备 mergeSnapshots。
 * - 旧文档无此元数据 → hydrate 直接回退 createCollabState 的 lamport=0 播种（向后兼容）。
 */

export const COLLAB_META_PERSIST_VERSION = 1;

export interface PersistedCollabMeta {
  v: number;
  docId: string;
  /** 本端 Lamport 时钟水位（reload 后抬钟，避免 lamport 回退导致的覆盖）。 */
  clockValue: number;
  vv: VersionVector;
  nodeMeta: Record<string, EntityMeta>;
  edgeMeta: Record<string, EntityMeta>;
  docFields: Record<string, CollabState['docFields'][string]>;
  pageFields: Record<string, CollabState['pageFields'][string]>;
  regMeta: Record<string, RegisterMeta>;
  appliedOpIds: string[];
  log: OpEnvelope[];
  savedAt: number;
}

/** 从运行态切片出可持久化的元数据（doc 本体不落这里）。 */
export function serializeCollabMeta(
  state: CollabState,
  clockValue: number,
  now: () => number = () => Date.now(),
): PersistedCollabMeta {
  return {
    v: COLLAB_META_PERSIST_VERSION,
    docId: state.docId,
    clockValue,
    vv: { ...state.vv },
    nodeMeta: state.nodeMeta,
    edgeMeta: state.edgeMeta,
    docFields: state.docFields,
    pageFields: state.pageFields,
    regMeta: state.regMeta,
    appliedOpIds: state.appliedOpIds,
    log: state.log,
    savedAt: now(),
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/** 防御性校验：持久化行结构是否可被信任。 */
function isValidPersistedMeta(raw: unknown, docId: string): raw is PersistedCollabMeta {
  if (!isRecord(raw)) return false;
  if (raw.v !== COLLAB_META_PERSIST_VERSION) return false;
  if (raw.docId !== docId) return false;
  if (typeof raw.clockValue !== 'number' || !Number.isFinite(raw.clockValue)) return false;
  if (!isRecord(raw.vv) || !isRecord(raw.nodeMeta) || !isRecord(raw.edgeMeta)) return false;
  if (!isRecord(raw.docFields) || !isRecord(raw.pageFields) || !isRecord(raw.regMeta)) return false;
  if (!Array.isArray(raw.appliedOpIds) || !Array.isArray(raw.log)) return false;
  return true;
}

/**
 * 用已落盘 doc + 持久化元数据重建 CollabState。
 *
 * 策略：先 createCollabState(doc) 播种（新实体 lamport=0 兜底），再用持久化元数据覆盖：
 *  - nodeMeta/edgeMeta：doc 中仍存在的实体用持久化时钟；doc 中新增的实体保持播种时钟；
 *    持久化里已不存在（doc 里已删）的实体丢弃。
 *  - vv / docFields / pageFields / regMeta / appliedOpIds / log：整体覆盖。
 *
 * @returns 重建后的 state；persisted 缺/损坏时返回 null（调用方回退纯播种）。
 */
export function hydrateCollabMeta(
  doc: KBNoteDoc,
  raw: unknown,
): { state: CollabState; clockValue: number } | null {
  if (!isValidPersistedMeta(raw, doc.id)) return null;
  const persisted: PersistedCollabMeta = raw;

  const base = createCollabState(doc, createLamportClock(persisted.clockValue));

  // nodeMeta：保留 doc 现存实体；持久化有则覆盖，无则保持播种的 lamport=0。
  const nodeMeta: Record<string, EntityMeta> = {};
  for (const n of doc.nodes) {
    nodeMeta[n.id] = persisted.nodeMeta[n.id] ?? base.nodeMeta[n.id]!;
  }
  const edgeMeta: Record<string, EntityMeta> = {};
  for (const e of doc.edges) {
    edgeMeta[e.id] = persisted.edgeMeta[e.id] ?? base.edgeMeta[e.id]!;
  }

  return {
    state: {
      ...base,
      vv: persisted.vv,
      nodeMeta,
      edgeMeta,
      docFields: persisted.docFields,
      pageFields: persisted.pageFields,
      regMeta: persisted.regMeta,
      appliedOpIds: persisted.appliedOpIds,
      log: persisted.log,
    },
    clockValue: persisted.clockValue,
  };
}

export type { ClientId };
