import type { KBNoteDoc, BlockNode, Edge, PageSettings, DocRefLink, Tag } from '../model/index.js';
import type { CollabConflict } from '../collab/conflicts.js';
import { sideOf, summarizeConflicts } from '../collab/conflicts.js';
import { lwwBeats, mergeVersions } from '../collab/clock.js';
import type { EventMarker } from '../collab/clock.js';
import type { SyncBlock, EntitySyncMeta, FMarkTuple } from './types.js';
import { emptySyncBlock } from './types.js';

/**
 * 快照级合并纯函数（Wave10 阶段 A，契约冻结）。
 *
 * 输入：两份「带同步元数据」的 v3 KBNoteDoc（.sync 必含）。
 *
 * 语义（复用 Wave9 collab 的 Lamport 全序）：
 * - 字段级 LWW：lamport 大者胜；相等时 clientId 字典序小者胜。
 * - 三路（提供 base）：只有当 local 与 remote **都相对 base 改了同一字段且取值不同**
 *   才算并发冲突；只一方改 → 静默快进，不报假冲突。
 * - 两路（无 base）：退化为「两端字段戳不同且取值不同即冲突」的保守 LWW。
 * - 删除优先 + 墓碑：一方删除、另一方编辑 → 墓碑胜（不复活），败方入 conflicts。
 * - 幂等：同一 remote 重复合入结果文档不变；合并交换律成立（环回收敛）。
 *
 * 零 DOM / 零定时器 / 不引新依赖；除 docId 不匹配外不抛业务错误。
 */

export interface MergeResult {
  doc: KBNoteDoc;
  conflicts: CollabConflict[];
  /** 中文摘要（= summarizeConflicts(conflicts)）。 */
  summary: string[];
}

function eqJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function syncOf(doc: KBNoteDoc): SyncBlock {
  return doc.sync ?? emptySyncBlock();
}

// ---- 节点 / 边字段读写（edge.color 映射到 edge.style.color）----

function getNodeField(n: BlockNode, f: string): unknown {
  return (n as unknown as Record<string, unknown>)[f];
}
function setNodeField(n: BlockNode, f: string, v: unknown): BlockNode {
  return { ...(n as unknown as Record<string, unknown>), [f]: v } as unknown as BlockNode;
}
function getEdgeField(e: Edge, f: string): unknown {
  if (f === 'color') return e.style.color;
  return (e as unknown as Record<string, unknown>)[f];
}
function setEdgeField(e: Edge, f: string, v: unknown): Edge {
  if (f === 'color') return { ...e, style: { ...e.style, color: v as string } };
  return { ...(e as unknown as Record<string, unknown>), [f]: v } as unknown as Edge;
}

function cloneMeta(m: EntitySyncMeta): EntitySyncMeta {
  const out: EntitySyncMeta = {};
  if (m.t) out.t = [...m.t] as FMarkTuple;
  if (m.f) out.f = Object.fromEntries(Object.entries(m.f).map(([k, v]) => [k, [...v] as FMarkTuple]));
  return out;
}

/** 比较两个戳：>0 a 晚于 b。 */
function compareMarkTuple(a: FMarkTuple, b: FMarkTuple): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] === b[1]) return 0;
  return a[1] < b[1] ? 1 : -1;
}

/** 取实体元数据里最新的字段写入标记（删除-vs-编辑冲突的败方定位）。 */
function maxFieldMark(meta: EntitySyncMeta | undefined, fallback: FMarkTuple): FMarkTuple {
  if (!meta?.f) return fallback;
  let best: FMarkTuple = fallback;
  for (const t of Object.values(meta.f)) if (compareMarkTuple(t, best) > 0) best = t;
  return best;
}

function pushFieldConflict(
  conflicts: CollabConflict[],
  kind: 'node' | 'edge',
  id: string,
  field: string,
  wMark: EventMarker,
  wVal: unknown,
  lMark: EventMarker,
  lVal: unknown,
): void {
  const isReparent = kind === 'node' && field === 'parentId';
  conflicts.push({
    entity: kind,
    entityId: id,
    field,
    kind: isReparent ? 'reparent' : 'field-lww',
    winner: sideOf(wMark, wVal),
    loser: sideOf(lMark, lVal),
    reason: isReparent
      ? `并发 reparent：${wMark.clientId} 与 ${lMark.clientId} 同时把节点 ${id} 挂到不同父`
      : `并发字段写：${wMark.clientId} 与 ${lMark.clientId} 同时写 ${kind}.${field}`,
  });
}

/** 删除 vs 编辑：墓碑胜，败方入冲突（reason 字段记录删除语义）。 */
function pushDeleteVsEdit(
  conflicts: CollabConflict[],
  kind: 'node' | 'edge',
  id: string,
  tomb: FMarkTuple,
  editorMark: FMarkTuple,
  editedEntity: unknown,
): void {
  const tMark: EventMarker = { lamport: tomb[0], clientId: tomb[1] };
  const eMark: EventMarker = { lamport: editorMark[0], clientId: editorMark[1] };
  conflicts.push({
    entity: kind,
    entityId: id,
    field: '<deleted>',
    kind: 'field-lww',
    winner: sideOf(tMark, null),
    loser: sideOf(eMark, editedEntity),
    reason: `并发删除与编辑：${tMark.clientId} 删除了该${kind === 'node' ? '节点' : '边'}，${eMark.clientId} 仍在编辑；按删除优先保留删除结果（墓碑 lamport ${tMark.lamport}）`,
  });
}

/**
 * 逐字段合并（三路感知）。
 * @param baseValueOf 返回某字段在 base 中的值；无 base 时为 undefined。
 */
function mergeFields<T extends { id: string }>(args: {
  kind: 'node' | 'edge';
  entityId: string;
  a: T;
  b: T;
  ma: EntitySyncMeta | undefined;
  mb: EntitySyncMeta | undefined;
  getValue: (e: T, f: string) => unknown;
  setValue: (e: T, f: string, v: unknown) => T;
  baseValueOf: ((field: string) => unknown) | undefined;
  conflicts: CollabConflict[];
}): { entity: T; meta: EntitySyncMeta } {
  const { kind, entityId, a, b, ma, mb, getValue, setValue, baseValueOf, conflicts } = args;
  let entity = a;
  const fOut: Record<string, FMarkTuple> = {};
  const fields = new Set<string>([...Object.keys(ma?.f ?? {}), ...Object.keys(mb?.f ?? {})]);

  for (const f of [...fields].sort()) {
    const la = ma?.f?.[f];
    const lb = mb?.f?.[f];
    const va = getValue(a, f);
    const vb = getValue(b, f);

    if (la && !lb) { fOut[f] = la; continue; }
    if (lb && !la) { fOut[f] = lb; entity = setValue(entity, f, vb); continue; }
    if (!la || !lb) continue;
    if (la[0] === lb[0] && la[1] === lb[1]) { fOut[f] = la; continue; }

    const aMark: EventMarker = { lamport: la[0], clientId: la[1] };
    const bMark: EventMarker = { lamport: lb[0], clientId: lb[1] };
    const aWins = lwwBeats(aMark, bMark);

    if (eqJson(va, vb)) { fOut[f] = aWins ? la : lb; continue; }

    // 三路：只有当 local 与 remote 都相对 base 改了该字段才算并发冲突；
    // 只一方偏离 base → 静默快进，不报假冲突。
    if (baseValueOf) {
      const bv = baseValueOf(f);
      const aChanged = !eqJson(va, bv);
      const bChanged = !eqJson(vb, bv);
      if (aChanged && !bChanged) { fOut[f] = la; continue; }   // A 改了，B 没动
      if (!aChanged && bChanged) { fOut[f] = lb; entity = setValue(entity, f, vb); continue; }
      // 双方都改了 → LWW + 冲突
    }

    if (aWins) {
      pushFieldConflict(conflicts, kind, entityId, f, aMark, va, bMark, vb);
      fOut[f] = la;
    } else {
      pushFieldConflict(conflicts, kind, entityId, f, bMark, vb, aMark, va);
      entity = setValue(entity, f, vb);
      fOut[f] = lb;
    }
  }
  return { entity, meta: { f: fOut } };
}

interface EntitySetResult<T> {
  list: T[];
  meta: Record<string, EntitySyncMeta>;
}

/** 合并一类实体（节点或边）。 */
function mergeEntitySet<T extends { id: string }>(args: {
  kind: 'node' | 'edge';
  listA: T[];
  listB: T[];
  metaA: Record<string, EntitySyncMeta> | undefined;
  metaB: Record<string, EntitySyncMeta> | undefined;
  baseList: T[] | undefined;
  baseMeta: Record<string, EntitySyncMeta> | undefined;
  getValue: (e: T, f: string) => unknown;
  setValue: (e: T, f: string, v: unknown) => T;
  conflicts: CollabConflict[];
}): EntitySetResult<T> {
  const { kind, listA, listB, metaA, metaB, baseList, baseMeta, getValue, setValue, conflicts } = args;
  const mapA = new Map<string, T>();
  for (const e of listA) mapA.set(e.id, e);
  const mapB = new Map<string, T>();
  for (const e of listB) mapB.set(e.id, e);
  const baseMap = new Map<string, T>();
  if (baseList) for (const e of baseList) baseMap.set(e.id, e);

  const ids = new Set<string>([
    ...mapA.keys(), ...mapB.keys(),
    ...Object.keys(metaA ?? {}), ...Object.keys(metaB ?? {}),
    ...Object.keys(baseMeta ?? {}),
  ]);
  const out: T[] = [];
  const outMeta: Record<string, EntitySyncMeta> = {};

  for (const id of [...ids].sort()) {
    const a = mapA.get(id);
    const b = mapB.get(id);
    const base = baseMap.get(id);
    const ma = metaA?.[id];
    const mb = metaB?.[id];
    const tombA = ma?.t;
    const tombB = mb?.t;

    if (a && b) {
      const baseValueOf = base ? (f: string): unknown => getValue(base, f) : undefined;
      const { entity, meta } = mergeFields({
        kind, entityId: id, a, b, ma, mb, getValue, setValue, baseValueOf, conflicts,
      });
      out.push(entity);
      outMeta[id] = meta;
      continue;
    }

    if (a && !b) {
      if (tombB) {
        pushDeleteVsEdit(conflicts, kind, id, tombB, maxFieldMark(ma, tombB), a);
        outMeta[id] = { t: tombB };
        continue;
      }
      out.push(a);
      outMeta[id] = ma ? cloneMeta(ma) : {};
      continue;
    }
    if (b && !a) {
      if (tombA) {
        pushDeleteVsEdit(conflicts, kind, id, tombA, maxFieldMark(mb, tombA), b);
        outMeta[id] = { t: tombA };
        continue;
      }
      out.push(b);
      outMeta[id] = mb ? cloneMeta(mb) : {};
      continue;
    }

    // 两侧都不在数组里：base 有它说明被双方删除（墓碑可能被裁剪）；传播较新墓碑。
    if (tombA && tombB) {
      outMeta[id] = { t: compareMarkTuple(tombA, tombB) >= 0 ? tombA : tombB };
    } else if (tombA) outMeta[id] = { t: tombA };
    else if (tombB) outMeta[id] = { t: tombB };
    else if (base) outMeta[id] = {}; // 双方都删了，无墓碑记录：保持删除
  }

  out.sort((p, q) => (p.id < q.id ? -1 : 1));
  return { list: out, meta: outMeta };
}

/** 文档级 / 分页字段合并（三路感知）。 */
function mergeScalarFields(args: {
  entity: 'doc' | 'page';
  fields: string[];
  a: Record<string, unknown>;
  b: Record<string, unknown>;
  base: Record<string, unknown> | undefined;
  metaA: Record<string, FMarkTuple> | undefined;
  metaB: Record<string, FMarkTuple> | undefined;
  conflicts: CollabConflict[];
}): { value: Record<string, unknown>; meta: Record<string, FMarkTuple> } {
  const { entity, fields, a, b, base, metaA, metaB, conflicts } = args;
  const out: Record<string, unknown> = { ...a };
  const fOut: Record<string, FMarkTuple> = {};

  for (const f of fields) {
    const la = metaA?.[f];
    const lb = metaB?.[f];
    const va = a[f];
    const vb = b[f];
    if (la && !lb) { fOut[f] = la; continue; }
    if (lb && !la) { fOut[f] = lb; out[f] = vb; continue; }
    if (!la || !lb) continue;
    if (la[0] === lb[0] && la[1] === lb[1]) { fOut[f] = la; continue; }
    const aMark: EventMarker = { lamport: la[0], clientId: la[1] };
    const bMark: EventMarker = { lamport: lb[0], clientId: lb[1] };
    const aWins = lwwBeats(aMark, bMark);
    if (eqJson(va, vb)) { fOut[f] = aWins ? la : lb; continue; }

    if (base) {
      const bv = base[f];
      const aChanged = !eqJson(va, bv);
      const bChanged = !eqJson(vb, bv);
      if (aChanged && !bChanged) { fOut[f] = la; continue; }
      if (!aChanged && bChanged) { fOut[f] = lb; out[f] = vb; continue; }
    }

    if (aWins) {
      conflicts.push({ entity, entityId: null, field: f, kind: 'field-lww', winner: sideOf(aMark, va), loser: sideOf(bMark, vb), reason: `并发字段写：${aMark.clientId} 与 ${bMark.clientId} 同时写 ${entity}.${f}` });
      fOut[f] = la;
    } else {
      conflicts.push({ entity, entityId: null, field: f, kind: 'field-lww', winner: sideOf(bMark, vb), loser: sideOf(aMark, va), reason: `并发字段写：${bMark.clientId} 与 ${aMark.clientId} 同时写 ${entity}.${f}` });
      fOut[f] = lb;
      out[f] = vb;
    }
  }
  return { value: out, meta: fOut };
}

function unionById<T extends { id: string }>(a: T[], b: T[]): T[] {
  const m = new Map<string, T>();
  for (const x of a) m.set(x.id, x);
  for (const x of b) if (!m.has(x.id)) m.set(x.id, x);
  return [...m.values()].sort((p, q) => (p.id < q.id ? -1 : 1));
}

/**
 * 快照合并主入口。
 * @param local 本端 v3 文档
 * @param remote 对端 v3 文档
 * @param base 可选三方基线（上次同步点）。提供后未偏离 base 的一侧视为快进，不报假冲突。
 * @throws Error 当两份文档 id 不一致
 */
export function mergeSnapshots(local: KBNoteDoc, remote: KBNoteDoc, base?: KBNoteDoc): MergeResult {
  if (local.id !== remote.id) {
    throw new Error(`[sync] mergeSnapshots docId 不匹配：${local.id} vs ${remote.id}`);
  }
  const A = syncOf(local);
  const B = syncOf(remote);
  const conflicts: CollabConflict[] = [];

  const nodes = mergeEntitySet<BlockNode>({
    kind: 'node',
    listA: local.nodes, listB: remote.nodes,
    metaA: A.nodes, metaB: B.nodes,
    baseList: base?.nodes, baseMeta: base?.sync?.nodes,
    getValue: getNodeField, setValue: setNodeField,
    conflicts,
  });
  const edges = mergeEntitySet<Edge>({
    kind: 'edge',
    listA: local.edges, listB: remote.edges,
    metaA: A.edges, metaB: B.edges,
    baseList: base?.edges, baseMeta: base?.sync?.edges,
    getValue: getEdgeField, setValue: setEdgeField,
    conflicts,
  });

  const docMerged = mergeScalarFields({
    entity: 'doc', fields: ['title'],
    a: { title: local.title }, b: { title: remote.title },
    base: base ? { title: base.title } : undefined,
    metaA: A.docF, metaB: B.docF, conflicts,
  });
  const title = typeof docMerged.value['title'] === 'string' ? (docMerged.value['title'] as string) : local.title;

  const pageFields = ['orientation', 'marginMm', 'mode', 'showPageBreak', 'colorMode', 'header', 'footer', 'showPageNumbers', 'edgeLabels', 'pageBreaks', 'pageOrigin'];
  const pageMerged = mergeScalarFields({
    entity: 'page', fields: pageFields,
    a: { ...(local.page as unknown as Record<string, unknown>) },
    b: { ...(remote.page as unknown as Record<string, unknown>) },
    base: base ? { ...(base.page as unknown as Record<string, unknown>) } : undefined,
    metaA: A.pageF, metaB: B.pageF, conflicts,
  });
  const page = { ...local.page, ...pageMerged.value } as PageSettings;

  const vv = mergeVersions(A.vv ?? {}, B.vv ?? {});
  const assetRefs = unionById(local.assetRefs.map((r) => ({ id: r })), remote.assetRefs.map((r) => ({ id: r }))).map((x) => x.id);
  const links = unionById<DocRefLink>(local.links, remote.links);
  const tags = unionById<Tag>(local.tags, remote.tags);
  const board = {
    createdAt: Math.min(local.board.createdAt, remote.board.createdAt),
    updatedAt: Math.max(local.board.updatedAt, remote.board.updatedAt),
  };

  const sync: SyncBlock = {
    vv,
    docF: docMerged.meta,
    pageF: pageMerged.meta,
    nodes: nodes.meta,
    edges: edges.meta,
  };

  const doc: KBNoteDoc = {
    ...local, title, board,
    nodes: nodes.list, edges: edges.list, tags, page,
    assetRefs, links, sync,
  };
  void base;

  return { doc, conflicts, summary: summarizeConflicts(conflicts) };
}
