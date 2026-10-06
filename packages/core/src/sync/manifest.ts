import type { KBNoteDoc } from '../model/index.js';
import type { VersionVector } from '../collab/clock.js';
import { compareVersions, mergeVersions } from '../collab/clock.js';

/**
 * 同步清单（Manifest）纯函数：
 * - 不碰二进制 IO、不碰网络；B 端（WebDAV / FSA）按这里算好的清单去传文件与资产。
 * - manifest 只描述「每文档需要 push/pull/合并哪些 .kbnote 与缺失资产」，
 *   文档本体由 mergeSnapshots 合并，资产二进制按内容 hash 去重传输。
 */

// ---- 确定性内容 hash（FNV-1a，纯函数，无 crypto 依赖）----

/** 把对象规范化成「键序递归排序」的 JSON 字符串（供 hash 稳定）。 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(rec[k])}`).join(',')}}`;
}

/** FNV-1a 64-bit（用两个 32 位段拼出 16 进制串，避免大数精度问题）。 */
export function canonicalHash(value: unknown): string {
  const str = canonicalStringify(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193);
  }
  const part = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return part(h1) + part(h2);
}

// ---- Manifest 形状 ----

/** 单个文档的同步摘要。 */
export interface DocManifest {
  id: string;
  title: string;
  /** 文档内容 hash（不含同步元数据），用于快速判断「内容是否变了」。 */
  hash: string;
  /** schema 版本（应为 3）。 */
  version: number;
  /** 文档版本向量。 */
  vv: VersionVector;
  /** 墓碑集（被删除但仍需抑制复活的节点/边 id）。 */
  tombstones: { nodes: string[]; edges: string[] };
  /** 资产标识清单（当前 = assetRef id；B 端按内容 hash 命名以去重传输）。 */
  assets: string[];
  /** board.updatedAt（最近修改时间，排序/展示用）。 */
  modifiedAt: number;
}

/** 一台设备上「全部文档」的同步清单。 */
export interface SyncManifest {
  /** 设备标识（B 端填；core 不生成随机 id）。 */
  deviceId: string;
  docs: Record<string, DocManifest>;
}

/** 每文档的同步方向判定。 */
export type DocSyncStatus =
  | 'equal'        // 两边内容一致
  | 'local-only'   // 本端独有（新文档）→ push
  | 'remote-only'  // 对端独有（新文档）→ pull
  | 'local-ahead' // 本端因果领先 → push
  | 'remote-ahead' // 对端因果领先 → pull
  | 'concurrent';  // 双方并发 → 双向同步后 mergeSnapshots

/** 从一份 v3 文档构建清单条目。 */
export function manifestFromDoc(doc: KBNoteDoc): DocManifest {
  const sync = doc.sync;
  const tombNodes = sync?.nodes ? Object.keys(sync.nodes).filter((id) => sync.nodes?.[id]?.t) : [];
  const tombEdges = sync?.edges ? Object.keys(sync.edges).filter((id) => sync.edges?.[id]?.t) : [];
  // 内容 hash：剔除 sync（合并过程本身会变），只看正文/图/视图。
  const { sync: _omit, ...content } = doc as KBNoteDoc & { sync?: unknown };
  void _omit;
  return {
    id: doc.id,
    title: doc.title,
    hash: canonicalHash(content),
    version: doc.version,
    vv: { ...(sync?.vv ?? {}) },
    tombstones: { nodes: [...tombNodes].sort(), edges: [...tombEdges].sort() },
    assets: [...doc.assetRefs].sort(),
    modifiedAt: doc.board.updatedAt,
  };
}

// ---- 差异判定 ----

/** 逐文档比较两份清单，给出 push/pull/相等/并发 决策。 */
export function diffManifests(local: SyncManifest, remote: SyncManifest): Record<string, DocSyncStatus> {
  const out: Record<string, DocSyncStatus> = {};
  const ids = new Set<string>([...Object.keys(local.docs), ...Object.keys(remote.docs)]);
  for (const id of ids) {
    const l = local.docs[id];
    const r = remote.docs[id];
    if (l && !r) {
      out[id] = 'local-only';
      continue;
    }
    if (!l && r) {
      out[id] = 'remote-only';
      continue;
    }
    // 两边都有
    if (l!.hash === r!.hash && JSON.stringify(l!.vv) === JSON.stringify(r!.vv)) {
      out[id] = 'equal';
      continue;
    }
    out[id] = compareVersions(l!.vv, r!.vv) === 'after' ? 'local-ahead'
      : compareVersions(l!.vv, r!.vv) === 'before' ? 'remote-ahead'
      : 'concurrent';
  }
  return out;
}

// ---- 增量分片计划 ----

/** 一次同步需要传输的最小分片集合。 */
export interface SyncBundle {
  /** 需要上传给对端的文档 id（本端独有 / 本端领先）。 */
  pushDocIds: string[];
  /** 需要从对端拉取的文档 id（对端独有 / 对端领先）。 */
  pullDocIds: string[];
  /** 双方并发：需拉远端文档后跑 mergeSnapshots。 */
  mergeDocIds: string[];
  /** 本端缺失、需要从对端下载的资产标识（按 hash 去重，不重复传）。 */
  missingAssets: string[];
}

/** 根据清单差异，算出增量分片。 */
export function planBundle(local: SyncManifest, remote: SyncManifest): SyncBundle {
  const diff = diffManifests(local, remote);
  const pushDocIds: string[] = [];
  const pullDocIds: string[] = [];
  const mergeDocIds: string[] = [];
  for (const [id, status] of Object.entries(diff)) {
    if (status === 'local-only' || status === 'local-ahead') pushDocIds.push(id);
    else if (status === 'remote-only' || status === 'remote-ahead') pullDocIds.push(id);
    else if (status === 'concurrent') mergeDocIds.push(id);
  }
  // 缺失资产：对端有、本端没有（按并集差）。
  const localAssets = new Set<string>();
  for (const d of Object.values(local.docs)) for (const a of d.assets) localAssets.add(a);
  const remoteAssets = new Set<string>();
  for (const d of Object.values(remote.docs)) for (const a of d.assets) remoteAssets.add(a);
  const missingAssets = [...remoteAssets].filter((a) => !localAssets.has(a)).sort();

  return {
    pushDocIds: pushDocIds.sort(),
    pullDocIds: pullDocIds.sort(),
    mergeDocIds: mergeDocIds.sort(),
    missingAssets,
  };
}

// ---- 水位推进（环回/多轮同步的状态机）----

/** 已同步水位：每文档记录「已确认对端见过的版本向量」。 */
export interface SyncCursor {
  /** docId → 上次成功同步后合并得到的版本向量。 */
  vvByDoc: Record<string, VersionVector>;
}

export function emptyCursor(): SyncCursor {
  return { vvByDoc: {} };
}

/**
 * 一轮同步成功后推进水位：用合并后文档的 vv 记录下来。
 * 下一轮 diff 用「本端 vv vs 水位」判断是否还有未同步出去的本地变更。
 */
export function advanceWatermark(cursor: SyncCursor, mergedDoc: KBNoteDoc): SyncCursor {
  return {
    vvByDoc: { ...cursor.vvByDoc, [mergedDoc.id]: { ...(mergedDoc.sync?.vv ?? {}) } },
  };
}

/** 判定某文档是否还有「已在本端但尚未同步给对端」的新事件（vv 领先水位）。 */
export function hasUnsyncedChanges(cursor: SyncCursor, doc: KBNoteDoc): boolean {
  const watermark = cursor.vvByDoc[doc.id];
  const vv = doc.sync?.vv ?? {};
  if (!watermark) return Object.keys(vv).length > 0;
  return compareVersions(vv, watermark) !== 'equal';
}

/** 合并两个水位（两台设备同步后取逐分量 max）。 */
export function mergeCursors(a: SyncCursor, b: SyncCursor): SyncCursor {
  const vvByDoc: Record<string, VersionVector> = {};
  for (const id of new Set([...Object.keys(a.vvByDoc), ...Object.keys(b.vvByDoc)])) {
    vvByDoc[id] = mergeVersions(a.vvByDoc[id] ?? {}, b.vvByDoc[id] ?? {});
  }
  return { vvByDoc };
}
