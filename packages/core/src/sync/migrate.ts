import type { FMarkTuple } from './types.js';
import {
  NODE_CLOCKED_FIELDS,
  EDGE_CLOCKED_FIELDS,
  DOC_CLOCKED_FIELDS,
  PAGE_CLOCKED_FIELDS,
} from './types.js';

/**
 * v2 → v3 确定性迁移（Wave10 阶段 A）。
 *
 * 目标：给存量节点/边/文档/分页字段补「同步时钟戳」，且**同一 v2 档在两台设备升级后
 * 得到逐字节一致的戳**（否则首次同步全是假冲突）。
 *
 * 确定性来源（全部来自文件本身，无随机、无 Date.now、无 nanoid）：
 * - lamport 基线 = floor(board.updatedAt)（毫秒 epoch，天然单调）；
 *   board.updatedAt ≤ 0 时回退 board.createdAt；仍 ≤ 0 时取 1。
 * - clientId 种子 = `seed:${doc.id}`（由文档 id 确定性派生，固定字符串）。
 * - v2 的 BlockNode / Edge 没有逐记录时间字段，因此同一文档内所有存量记录
 *   全部继承同一个文档级戳 `[baseLamport, seedClientId]` —— 幂等且一致。
 *
 * 升级后 B 端必须把本端 Lamport 时钟抬到 ≥ baseLamport（见 adoptClockFloor），
 * 否则本地新编辑（lamport 从 0 起跳）会输给这个迁移戳。
 */

/** 迁移写入文档的固定种子 clientId 前缀。 */
export const MIGRATION_CLIENT_PREFIX = 'seed:' as const;

/** 由 docId 确定性派生迁移用 clientId。 */
export function seedClientIdFor(docId: string): string {
  return `${MIGRATION_CLIENT_PREFIX}${docId}`;
}

/** 计算迁移 lamport 基线（纯函数：只看 board 时间戳）。 */
export function migrationLamport(board: { createdAt?: unknown; updatedAt?: unknown } | undefined): number {
  const updated = typeof board?.updatedAt === 'number' && Number.isFinite(board.updatedAt) ? board.updatedAt : 0;
  const created = typeof board?.createdAt === 'number' && Number.isFinite(board.createdAt) ? board.createdAt : 0;
  const v = Math.floor(Math.max(updated, created));
  return v > 0 ? v : 1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 收集一个节点上「实际存在」的被时钟化字段 → 全部打上同一迁移戳。 */
function clockNodeFields(node: Record<string, unknown>, mark: FMarkTuple): Record<string, FMarkTuple> {
  const f: Record<string, FMarkTuple> = {};
  for (const key of NODE_CLOCKED_FIELDS) {
    if (key in node) f[key] = mark;
  }
  return f;
}

/** 收集一条边上「实际存在」的被时钟化字段。color 来自 edge.style.color。 */
function clockEdgeFields(edge: Record<string, unknown>, mark: FMarkTuple): Record<string, FMarkTuple> {
  const f: Record<string, FMarkTuple> = {};
  for (const key of EDGE_CLOCKED_FIELDS) {
    if (key === 'color') {
      if (isRecord(edge['style']) && 'color' in edge['style']) f['color'] = mark;
    } else if (key in edge) {
      f[key] = mark;
    }
  }
  return f;
}

/**
 * v2 JSON 对象 → v3 JSON 对象（注入 sync 块，version 置 3）。
 * 坏输入（不是对象）原样透传，交由后续 zod 校验拒绝，不抛、不污染。
 */
export function migrateV2ToV3(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const obj = raw as Record<string, unknown>;

  const docId = typeof obj['id'] === 'string' ? obj['id'] : '';
  const mark: FMarkTuple = [migrationLamport(obj['board'] as { createdAt?: unknown; updatedAt?: unknown }), seedClientIdFor(docId)];

  // 节点元数据
  const nodeMeta: Record<string, { f: Record<string, FMarkTuple> }> = {};
  if (Array.isArray(obj['nodes'])) {
    for (const n of obj['nodes']) {
      if (!isRecord(n) || typeof n['id'] !== 'string') continue;
      nodeMeta[n['id']] = { f: clockNodeFields(n, mark) };
    }
  }

  // 边元数据
  const edgeMeta: Record<string, { f: Record<string, FMarkTuple> }> = {};
  if (Array.isArray(obj['edges'])) {
    for (const e of obj['edges']) {
      if (!isRecord(e) || typeof e['id'] !== 'string') continue;
      edgeMeta[e['id']] = { f: clockEdgeFields(e, mark) };
    }
  }

  // 文档级字段（title）：存在才打戳
  const docF: Record<string, FMarkTuple> = {};
  for (const key of DOC_CLOCKED_FIELDS) {
    if (key in obj) docF[key] = mark;
  }

  // 分页字段
  const pageF: Record<string, FMarkTuple> = {};
  if (isRecord(obj['page'])) {
    for (const key of PAGE_CLOCKED_FIELDS) {
      if (key in (obj['page'] as Record<string, unknown>)) pageF[key] = mark;
    }
  }

  const sync = {
    vv: { [mark[1]]: mark[0] } as Record<string, number>,
    docF,
    pageF,
    nodes: nodeMeta,
    edges: edgeMeta,
  };

  return {
    ...obj,
    version: 3,
    sync,
  };
}

/**
 * v3 → v4 确定性迁移（Wave16 F 路）。
 *
 * 目标：把 assetRefs 规范化为「去重、去空、稳定顺序」的字符串数组，并把 schema
 * 版本抬到 4。内容寻址（文件名 = SHA-256 hex）的字节级重命名（旧 nanoid ref →
 * 内容 hash）发生在 web 侧——那里才有 OPFS 字节与 Web Crypto；core 只做纯 JSON
 * 规整，无法也不应读取 Blob。本步因此是幂等的：
 *  - 重复执行结果不变（assetRefs 本就去重时原样保留）；
 *  - 不丢资产（ref 字符串原样保留，只是去空/去重）。
 */
export function migrateV3ToV4(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  let assetRefs: unknown = obj['assetRefs'];
  if (Array.isArray(assetRefs)) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const ref of assetRefs) {
      if (typeof ref !== 'string' || ref.length === 0) continue;
      if (seen.has(ref)) continue;
      seen.add(ref);
      out.push(ref);
    }
    assetRefs = out;
  } else {
    assetRefs = [];
  }
  return {
    ...obj,
    version: 4,
    assetRefs,
  };
}
