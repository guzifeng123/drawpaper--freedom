import type { BlockNode, Edge } from '../model/index.js';
import type { CollabState, EntityMeta, RegisterMeta } from './state.js';
import { regKey } from './state.js';
import type { OpEnvelope } from './envelope.js';
import type { ClientId } from './identity.js';
import type { EventMarker } from './clock.js';
import { lwwBeats } from './clock.js';
import type { CollabConflict } from './conflicts.js';
import { sideOf } from './conflicts.js';
import type { EdgeFieldPatch, NodeFieldPatch } from './ops.js';

/**
 * 纯函数合并引擎：把一条远端/本地 op 信封应用到协作态。
 *
 * 不变量：
 * - opId 幂等：乱序、重复、延迟到达都安全（已应用 opId 直接跳过）。
 * - 字段级 LWW：同字段并发写，Lamport 大者胜；同 Lamport clientId 小者胜；不同字段互不干扰。
 * - 删除优先 + 墓碑：delete 打墓碑；旧 update 不复活；仅当 add-* 的 Lamport 严格大于墓碑才可重建。
 * - 败方不静默丢弃：并发写同字段不同值 → 写 conflicts 列表。
 *
 * 本模块零 DOM、零定时器、不抛业务错误（除 docId 路由不匹配）。
 */

export type ApplyOutcome =
  | 'applied' // 新应用，doc 发生变化
  | 'duplicate' // opId 已处理过
  | 'suppressed-tombstone' // 到达已被删除的实体（且未赢得墓碑）
  | 'no-op'; // 目标实体不存在 / patch 收敛，doc 未变

export interface ApplyResult {
  state: CollabState;
  outcome: ApplyOutcome;
  /** 本次应用新发现的并发冲突（败方记录）。 */
  conflicts: CollabConflict[];
}

function freshMeta(): EntityMeta {
  return { tombstone: null, fields: {} };
}

function eqJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** 可选块字段（收到 null 时应删除该键）。 */
const OPTIONAL_NODE_FIELDS = new Set([
  'todo', 'image', 'heading', 'bookmark', 'attachment', 'reminder',
]);

function setNodeField(n: BlockNode, key: string, value: unknown): BlockNode {
  if (OPTIONAL_NODE_FIELDS.has(key) && value === null) {
    const rest = { ...n } as Record<string, unknown>;
    delete rest[key];
    return rest as unknown as BlockNode;
  }
  return { ...n, [key]: value } as BlockNode;
}

function setEdgeField(e: Edge, key: string, value: unknown): Edge {
  if (key === 'color') {
    return { ...e, style: { ...e.style, color: value as string } };
  }
  if (key === 'points' && value === null) {
    const { points: _omit, ...rest } = e;
    return rest;
  }
  return { ...e, [key]: value } as Edge;
}

/** 记录一次并发字段冲突（胜方已生效，败方入列表）。 */
function pushConflict(
  out: CollabConflict[],
  entity: 'node' | 'edge' | 'doc' | 'page',
  entityId: string | null,
  field: string,
  winnerMark: EventMarker,
  winnerValue: unknown,
  loserMark: EventMarker,
  loserValue: unknown,
): void {
  out.push({
    entity,
    entityId,
    field,
    kind: field === 'parentId' && entity === 'node' ? 'reparent' : 'field-lww',
    winner: sideOf(winnerMark, winnerValue),
    loser: sideOf(loserMark, loserValue),
    reason:
      field === 'parentId' && entity === 'node'
        ? `并发 reparent：${winnerMark.clientId} 与 ${loserMark.clientId} 同时把节点 ${entityId} 挂到不同父`
        : `并发字段写：${winnerMark.clientId} 与 ${loserMark.clientId} 同时写 ${entity}.${field}`,
  });
}

/**
 * 把一组字段补丁按 LWW 落到单个节点上（不替换节点对象本体）。
 * @returns 新节点；若无任何字段变化则返回原节点引用。
 */
function applyNodeFields(
  node: BlockNode,
  patch: NodeFieldPatch,
  marker: EventMarker,
  meta: EntityMeta,
  conflicts: CollabConflict[],
): BlockNode {
  let out = node;
  for (const [key, value] of Object.entries(patch)) {
    const stored = meta.fields[key];
    if (!stored) {
      out = setNodeField(out, key, value);
      meta.fields[key] = { lamport: marker.lamport, clientId: marker.clientId, value };
      continue;
    }
    if (stored.clientId === marker.clientId) {
      out = setNodeField(out, key, value);
      meta.fields[key] = { lamport: marker.lamport, clientId: marker.clientId, value };
      continue;
    }
    if (eqJson(stored.value, value)) continue; // 两边写了一样的值，收敛无冲突
    const inc: EventMarker = { lamport: stored.lamport, clientId: stored.clientId };
    if (lwwBeats(marker, inc)) {
      pushConflict(conflicts, 'node', node.id, key, marker, value, inc, stored.value);
      out = setNodeField(out, key, value);
      meta.fields[key] = { lamport: marker.lamport, clientId: marker.clientId, value };
    } else {
      pushConflict(conflicts, 'node', node.id, key, inc, stored.value, marker, value);
    }
  }
  return out;
}

function applyEdgeFields(
  edge: Edge,
  patch: EdgeFieldPatch,
  marker: EventMarker,
  meta: EntityMeta,
  conflicts: CollabConflict[],
): Edge {
  let out = edge;
  for (const [key, value] of Object.entries(patch)) {
    const stored = meta.fields[key];
    if (!stored) {
      out = setEdgeField(out, key, value);
      meta.fields[key] = { lamport: marker.lamport, clientId: marker.clientId, value };
      continue;
    }
    if (stored.clientId === marker.clientId) {
      out = setEdgeField(out, key, value);
      meta.fields[key] = { lamport: marker.lamport, clientId: marker.clientId, value };
      continue;
    }
    if (eqJson(stored.value, value)) continue;
    const inc: EventMarker = { lamport: stored.lamport, clientId: stored.clientId };
    if (lwwBeats(marker, inc)) {
      pushConflict(conflicts, 'edge', edge.id, key, marker, value, inc, stored.value);
      out = setEdgeField(out, key, value);
      meta.fields[key] = { lamport: marker.lamport, clientId: marker.clientId, value };
    } else {
      pushConflict(conflicts, 'edge', edge.id, key, inc, stored.value, marker, value);
    }
  }
  return out;
}

/** 播种一个新建实体的全部字段时钟（add-node/add-edge 用）。 */
function seedNodeFields(meta: EntityMeta, node: BlockNode, marker: EventMarker): void {
  const rec: Record<string, unknown> = {
    x: node.x, y: node.y, width: node.width, height: node.height,
    content: node.content, parentId: node.parentId,
    pinned: node.pinned, locked: node.locked, collapsed: node.collapsed,
    tags: node.tags, style: node.style, type: node.type,
  };
  if (node.todo !== undefined) rec.todo = node.todo;
  if (node.image !== undefined) rec.image = node.image;
  if (node.heading !== undefined) rec.heading = node.heading;
  if (node.bookmark !== undefined) rec.bookmark = node.bookmark;
  if (node.attachment !== undefined) rec.attachment = node.attachment;
  if (node.reminder !== undefined) rec.reminder = node.reminder;
  for (const [k, v] of Object.entries(rec)) {
    meta.fields[k] = { lamport: marker.lamport, clientId: marker.clientId, value: v };
  }
}

function seedEdgeFields(meta: EntityMeta, edge: Edge, marker: EventMarker): void {
  const rec: Record<string, unknown> = {
    source: edge.source, target: edge.target,
    sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle,
    label: edge.label, color: edge.style.color,
  };
  if (edge.points !== undefined) rec.points = edge.points;
  for (const [k, v] of Object.entries(rec)) {
    meta.fields[k] = { lamport: marker.lamport, clientId: marker.clientId, value: v };
  }
}

/** 墓碑可否被一次「写入」复活：仅当新写入 Lamport 严格大于墓碑（删除优先）。 */
function canRevive(marker: EventMarker, tomb: { lamport: number }): boolean {
  return marker.lamport > tomb.lamport;
}

// ---------------- 寄存器并集（tags / points / pageBreaks）----------------

type RegField = 'tags' | 'points' | 'pageBreaks';

/** 寄存器元素的身份 key（同 key 视为同一元素）。 */
function regItemKey(field: RegField, item: unknown): string {
  if (field === 'tags') return `t:${String(item)}`;
  if (field === 'pageBreaks') {
    const b = item as { id?: string; at?: number };
    return b.id ? `b:${b.id}` : `b:${b.at}`;
  }
  const p = item as { x: number; y: number };
  return `p:${Math.round(p.x)},${Math.round(p.y)}`;
}

/** 读取 doc 上某寄存器当前数组（只读）。 */
function readRegArray(
  doc: CollabState['doc'],
  entity: 'node' | 'edge' | 'page',
  entityId: string,
  field: RegField,
): unknown[] | undefined {
  if (entity === 'node') {
    const n = doc.nodes.find((x) => x.id === entityId);
    if (!n) return undefined;
    return field === 'tags' ? (n.tags as unknown[]) : undefined;
  }
  if (entity === 'edge') {
    const e = doc.edges.find((x) => x.id === entityId);
    if (!e) return undefined;
    return field === 'points' ? (e.points as unknown[] | undefined) : undefined;
  }
  return field === 'pageBreaks' ? (doc.page.pageBreaks as unknown[]) : undefined;
}

/** 把新数组写回 doc（不可变更新）。返回新 doc。 */
function writeRegArray(
  doc: CollabState['doc'],
  entity: 'node' | 'edge' | 'page',
  entityId: string,
  arr: unknown[],
): CollabState['doc'] {
  if (entity === 'node') {
    return {
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === entityId ? ({ ...n, tags: arr as string[] } as BlockNode) : n,
      ),
    };
  }
  if (entity === 'edge') {
    return {
      ...doc,
      edges: doc.edges.map((e) =>
        e.id === entityId ? ({ ...e, points: arr as Edge['points'] }) : e,
      ),
    };
  }
  return { ...doc, page: { ...doc.page, pageBreaks: arr as typeof doc.page.pageBreaks } };
}

function emptyRegMeta(): RegisterMeta {
  return { adds: {}, removes: {} };
}

/**
 * 应用 reg-add：把 items 并入 doc 数组；被墓碑压住的旧 add 不复活。
 * 返回 { doc, regMeta, changed }。
 */
function applyRegAdd(
  doc: CollabState['doc'],
  regMeta: Record<string, RegisterMeta>,
  entity: 'node' | 'edge' | 'page',
  entityId: string,
  field: RegField,
  items: unknown[],
  marker: EventMarker,
): { doc: CollabState['doc']; regMeta: Record<string, RegisterMeta>; changed: boolean } {
  const key = regKey(entity, entityId, field);
  const meta: RegisterMeta = regMeta[key]
    ? { adds: { ...regMeta[key]!.adds }, removes: { ...regMeta[key]!.removes } }
    : emptyRegMeta();
  // 复制一份再改：doc 经 zustand immer 中间件冻结，不能 push 原数组。
  const cur = [...(readRegArray(doc, entity, entityId, field) ?? [])];
  const present = new Set(cur.map((it) => regItemKey(field, it)));
  let changed = false;
  for (const item of items) {
    const k = regItemKey(field, item);
    const tomb = meta.removes[k];
    if (tomb && !canRevive(marker, tomb)) continue; // 删除优先：旧 add 不复活
    meta.adds[k] = { lamport: marker.lamport, clientId: marker.clientId };
    delete meta.removes[k];
    if (!present.has(k)) {
      cur.push(item);
      present.add(k);
      changed = true;
    }
  }
  const nextReg = { ...regMeta, [key]: meta };
  return { doc: changed ? writeRegArray(doc, entity, entityId, cur) : doc, regMeta: nextReg, changed };
}

/**
 * 应用 reg-remove：按身份 key 删除数组元素并打墓碑。
 */
function applyRegRemove(
  doc: CollabState['doc'],
  regMeta: Record<string, RegisterMeta>,
  entity: 'node' | 'edge' | 'page',
  entityId: string,
  field: RegField,
  keys: string[],
  marker: EventMarker,
): { doc: CollabState['doc']; regMeta: Record<string, RegisterMeta>; changed: boolean } {
  const key = regKey(entity, entityId, field);
  const meta: RegisterMeta = regMeta[key]
    ? { adds: { ...regMeta[key]!.adds }, removes: { ...regMeta[key]!.removes } }
    : emptyRegMeta();
  const removeSet = new Set(keys);
  for (const k of keys) meta.removes[k] = { lamport: marker.lamport, clientId: marker.clientId };
  const cur = readRegArray(doc, entity, entityId, field) ?? [];
  const kept = cur.filter((it) => !removeSet.has(regItemKey(field, it)));
  const changed = kept.length !== cur.length;
  const nextReg = { ...regMeta, [key]: meta };
  return { doc: changed ? writeRegArray(doc, entity, entityId, kept) : doc, regMeta: nextReg, changed };
}

/** 为新建实体播种寄存器 adds（add-node/add-edge 用）：当前数组元素视为 marker 时刻加入。 */
function seedRegAdds(
  regMeta: Record<string, RegisterMeta>,
  doc: CollabState['doc'],
  entity: 'node' | 'edge' | 'page',
  entityId: string,
  field: RegField,
  marker: EventMarker,
): Record<string, RegisterMeta> {
  const arr = readRegArray(doc, entity, entityId, field);
  if (!arr || arr.length === 0) return regMeta;
  const key = regKey(entity, entityId, field);
  const meta: RegisterMeta = regMeta[key] ? { ...regMeta[key]!, adds: { ...regMeta[key]!.adds }, removes: { ...regMeta[key]!.removes } } : emptyRegMeta();
  for (const item of arr) {
    meta.adds[regItemKey(field, item)] = { lamport: marker.lamport, clientId: marker.clientId };
  }
  return { ...regMeta, [key]: meta };
}

/**
 * 主入口：应用一条 op 信封。纯函数，返回新状态与冲突列表。
 * @throws 仅当 env.docId 与 state.docId 不一致（路由 bug，B 端应在分发前拦截）。
 */
export function applyOp(state: CollabState, env: OpEnvelope): ApplyResult {
  if (env.docId !== state.docId) {
    throw new Error(
      `[collab] op docId 不匹配：env=${env.docId} state=${state.docId}（opId=${env.opId}）`,
    );
  }
  // 1) 幂等去重
  if (state.appliedOpIds.includes(env.opId)) {
    return { state, outcome: 'duplicate', conflicts: [] };
  }

  const marker: EventMarker = { lamport: env.lamport, clientId: env.clientId };
  const vv = { ...state.vv };
  vv[env.clientId] = Math.max(vv[env.clientId] ?? 0, env.lamport);

  let doc = state.doc;
  const nodeMeta = { ...state.nodeMeta };
  const edgeMeta = { ...state.edgeMeta };
  const docFields = { ...state.docFields };
  const pageFields = { ...state.pageFields };
  let regMeta = { ...state.regMeta };
  const conflicts: CollabConflict[] = [];
  let changed = true;

  const op = env.op;

  switch (op.kind) {
    case 'add-node': {
      // zod 已校验；推断类型与手写接口在 content.data 可选性上有出入，按仓库惯例 cast 边界。
      const node = op.node as unknown as BlockNode;
      const existing = doc.nodes.find((n) => n.id === node.id);
      const meta = nodeMeta[node.id] ? { ...nodeMeta[node.id]! } : freshMeta();
      if (existing) {
        if (meta.tombstone && !canRevive(marker, meta.tombstone)) {
          return { state: withBookkeeping(state, vv, doc, nodeMeta, edgeMeta, docFields, pageFields, regMeta, env), outcome: 'suppressed-tombstone', conflicts: [] };
        }
        // 复活或已存在：替换节点本体 + 重置字段时钟
        meta.tombstone = null;
        meta.fields = {};
        seedNodeFields(meta, node, marker);
        nodeMeta[node.id] = meta;
        doc = { ...doc, nodes: doc.nodes.map((n) => (n.id === node.id ? node : n)) };
      } else {
        // 节点已被移除：仍要检查墓碑——同/旧 lamport 的重建不复活（删除优先）。
        if (meta.tombstone && !canRevive(marker, meta.tombstone)) {
          return { state: withBookkeeping(state, vv, doc, nodeMeta, edgeMeta, docFields, pageFields, regMeta, env), outcome: 'suppressed-tombstone', conflicts: [] };
        }
        meta.tombstone = null;
        seedNodeFields(meta, node, marker);
        nodeMeta[node.id] = meta;
        doc = { ...doc, nodes: [...doc.nodes, node] };
      }
      regMeta = seedRegAdds(regMeta, doc, 'node', node.id, 'tags', marker);
      break;
    }

    case 'delete-nodes': {
      const idSet = new Set(op.nodeIds);
      // 级联墓碑入射/出射边
      const incident = doc.edges.filter((e) => idSet.has(e.source) || idSet.has(e.target));
      for (const id of op.nodeIds) {
        const meta = nodeMeta[id] ? { ...nodeMeta[id]! } : freshMeta();
        meta.tombstone = { lamport: env.lamport, clientId: env.clientId };
        nodeMeta[id] = meta;
      }
      for (const e of incident) {
        const em = edgeMeta[e.id] ? { ...edgeMeta[e.id]! } : freshMeta();
        em.tombstone = { lamport: env.lamport, clientId: env.clientId };
        edgeMeta[e.id] = em;
      }
      doc = {
        ...doc,
        nodes: doc.nodes.filter((n) => !idSet.has(n.id)),
        edges: doc.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target)),
      };
      break;
    }

    case 'update-node': {
      const node = doc.nodes.find((n) => n.id === op.nodeId);
      if (!node) {
        const meta = nodeMeta[op.nodeId];
        if (meta?.tombstone) {
          return { state: withBookkeeping(state, vv, doc, nodeMeta, edgeMeta, docFields, pageFields, regMeta, env), outcome: 'suppressed-tombstone', conflicts: [] };
        }
        changed = false; // 未知节点：记 opId 防重放，doc 不变
        break;
      }
      const meta = nodeMeta[node.id] ? { ...nodeMeta[node.id]! } : freshMeta();
      if (meta.tombstone) {
        return { state: withBookkeeping(state, vv, doc, nodeMeta, edgeMeta, docFields, pageFields, regMeta, env), outcome: 'suppressed-tombstone', conflicts: [] };
      }
      const next = applyNodeFields(node, op.patch, marker, meta, conflicts);
      nodeMeta[node.id] = meta;
      doc = { ...doc, nodes: doc.nodes.map((n) => (n.id === node.id ? next : n)) };
      break;
    }

    case 'add-edge': {
      const edge = op.edge as unknown as Edge;
      const existing = doc.edges.find((e) => e.id === edge.id);
      const meta = edgeMeta[edge.id] ? { ...edgeMeta[edge.id]! } : freshMeta();
      if (existing) {
        if (meta.tombstone && !canRevive(marker, meta.tombstone)) {
          return { state: withBookkeeping(state, vv, doc, nodeMeta, edgeMeta, docFields, pageFields, regMeta, env), outcome: 'suppressed-tombstone', conflicts: [] };
        }
        meta.tombstone = null;
        meta.fields = {};
        seedEdgeFields(meta, edge, marker);
        edgeMeta[edge.id] = meta;
        doc = { ...doc, edges: doc.edges.map((e) => (e.id === edge.id ? edge : e)) };
      } else {
        if (meta.tombstone && !canRevive(marker, meta.tombstone)) {
          return { state: withBookkeeping(state, vv, doc, nodeMeta, edgeMeta, docFields, pageFields, regMeta, env), outcome: 'suppressed-tombstone', conflicts: [] };
        }
        seedEdgeFields(meta, edge, marker);
        edgeMeta[edge.id] = meta;
        doc = { ...doc, edges: [...doc.edges, edge] };
      }
      regMeta = seedRegAdds(regMeta, doc, 'edge', edge.id, 'points', marker);
      break;
    }

    case 'delete-edge': {
      const meta = edgeMeta[op.edgeId] ? { ...edgeMeta[op.edgeId]! } : freshMeta();
      meta.tombstone = { lamport: env.lamport, clientId: env.clientId };
      edgeMeta[op.edgeId] = meta;
      doc = { ...doc, edges: doc.edges.filter((e) => e.id !== op.edgeId) };
      break;
    }

    case 'update-edge': {
      const edge = doc.edges.find((e) => e.id === op.edgeId);
      if (!edge) {
        const meta = edgeMeta[op.edgeId];
        if (meta?.tombstone) {
          return { state: withBookkeeping(state, vv, doc, nodeMeta, edgeMeta, docFields, pageFields, regMeta, env), outcome: 'suppressed-tombstone', conflicts: [] };
        }
        changed = false;
        break;
      }
      const meta = edgeMeta[edge.id] ? { ...edgeMeta[edge.id]! } : freshMeta();
      if (meta.tombstone) {
        return { state: withBookkeeping(state, vv, doc, nodeMeta, edgeMeta, docFields, pageFields, regMeta, env), outcome: 'suppressed-tombstone', conflicts: [] };
      }
      const next = applyEdgeFields(edge, op.patch, marker, meta, conflicts);
      edgeMeta[edge.id] = meta;
      doc = { ...doc, edges: doc.edges.map((e) => (e.id === edge.id ? next : e)) };
      break;
    }

    case 'move-nodes': {
      let any = false;
      for (const pos of op.positions) {
        const node = doc.nodes.find((n) => n.id === pos.nodeId);
        if (!node) continue;
        const meta = nodeMeta[node.id] ? { ...nodeMeta[node.id]! } : freshMeta();
        if (meta.tombstone) continue;
        const next = applyNodeFields(node, { x: pos.x, y: pos.y }, marker, meta, conflicts);
        nodeMeta[node.id] = meta;
        doc = { ...doc, nodes: doc.nodes.map((n) => (n.id === node.id ? next : n)) };
        any = true;
      }
      changed = any;
      break;
    }

    case 'set-doc-meta': {
      let any = false;
      for (const [key, value] of Object.entries(op.patch)) {
        const stored = docFields[key];
        if (!stored) {
          docFields[key] = { lamport: env.lamport, clientId: env.clientId, value };
          any = true;
          continue;
        }
        if (stored.clientId === env.clientId) {
          docFields[key] = { lamport: env.lamport, clientId: env.clientId, value };
          any = true;
          continue;
        }
        if (eqJson(stored.value, value)) continue;
        const inc: EventMarker = { lamport: stored.lamport, clientId: stored.clientId };
        if (lwwBeats(marker, inc)) {
          pushConflict(conflicts, 'doc', null, key, marker, value, inc, stored.value);
          docFields[key] = { lamport: env.lamport, clientId: env.clientId, value };
          any = true;
        } else {
          pushConflict(conflicts, 'doc', null, key, inc, stored.value, marker, value);
        }
      }
      doc = { ...doc, title: typeof op.patch.title === 'string' ? (docFields.title?.value as string ?? doc.title) : doc.title };
      changed = any;
      break;
    }

    case 'set-page': {
      let any = false;
      for (const [key, value] of Object.entries(op.patch)) {
        const stored = pageFields[key];
        if (!stored || stored.clientId === env.clientId || !eqJson(stored.value, value)) {
          const inc = stored ? ({ lamport: stored.lamport, clientId: stored.clientId } as EventMarker) : null;
          if (inc && stored && stored.clientId !== env.clientId) {
            if (lwwBeats(marker, inc)) {
              pushConflict(conflicts, 'page', null, key, marker, value, inc, stored.value);
            } else {
              pushConflict(conflicts, 'page', null, key, inc, stored.value, marker, value);
              continue; // 败方：不落值
            }
          }
          pageFields[key] = { lamport: env.lamport, clientId: env.clientId, value };
          any = true;
        }
      }
      const page = { ...doc.page };
      for (const [key, value] of Object.entries(op.patch)) {
        const clocked = pageFields[key];
        if (!clocked) continue;
        if (value === null && key === 'pageOrigin') delete page.pageOrigin;
        else (page as Record<string, unknown>)[key] = clocked.value;
      }
      doc = { ...doc, page };
      changed = any;
      break;
    }

    case 'reg-add': {
      const res = applyRegAdd(
        doc, regMeta, op.entity, op.entityId, op.field as RegField, op.items ?? [], marker,
      );
      doc = res.doc;
      regMeta = res.regMeta;
      changed = res.changed;
      break;
    }

    case 'reg-remove': {
      const res = applyRegRemove(
        doc, regMeta, op.entity, op.entityId, op.field as RegField, op.keys ?? [], marker,
      );
      doc = res.doc;
      regMeta = res.regMeta;
      changed = res.changed;
      break;
    }
  }

  const nextState = withBookkeeping(state, vv, doc, nodeMeta, edgeMeta, docFields, pageFields, regMeta, env);
  return { state: nextState, outcome: changed ? 'applied' : 'no-op', conflicts };
}

/** 统一收尾：写入 doc/vv/meta/opId/log（冲突已收集在闭包外）。 */
function withBookkeeping(
  state: CollabState,
  vv: Record<ClientId, number>,
  doc: CollabState['doc'],
  nodeMeta: CollabState['nodeMeta'],
  edgeMeta: CollabState['edgeMeta'],
  docFields: CollabState['docFields'],
  pageFields: CollabState['pageFields'],
  regMeta: CollabState['regMeta'],
  env: OpEnvelope,
): CollabState {
  return {
    ...state,
    vv,
    doc,
    nodeMeta,
    edgeMeta,
    docFields,
    pageFields,
    regMeta,
    appliedOpIds: [...state.appliedOpIds, env.opId],
    log: [...state.log, env],
  };
}
