import type { KBNoteDoc } from '../model/index.js';
import type { SyncBlock, EntitySyncMeta, FMarkTuple } from './types.js';
import { emptySyncBlock } from './types.js';

/**
 * 墓碑水位裁剪（Wave14 A 路，纯函数，零 DOM/宿主 API）。
 *
 * 背景：删除不进 nodes/edges 数组，而在 `sync.nodes[id].t` / `sync.edges[id].t`
 * 记一条 `[lamport, clientId]` 墓碑，用来压住「晚到的旧写入」防止被删实体复活。
 * 但墓碑集无界增长（长期高频删除），需要有界化。
 *
 * 安全第一语义（watermark / stable-time 策略，与 Wave10 §6 遗留一致）：
 * - 版本向量 `vv: Record<clientId, number>` 中 `vv[c]` = 已知客户端 c 已生成（tick）到的
 *   最高 Lamport。某客户端 c 一旦生成了 lamport ≥ W 的事件，按 Lamport 时钟因果，
 *   c 必然已经观测到所有 lamport < W 的事件（含删除）。
 * - 因此定义**安全水位 W = min over 已知客户端 c 的 vv[c]**。任何 lamport ≤ W 的删除事件，
 *   都可断言「全部已知客户端都已观测到」，其墓碑可以安全裁剪。
 * - 反过来：只要存在某个已知客户端 c 的 vv[c] < 墓碑 lamport，就不能证明 c 已观测该删除，
 *   墓碑必须保留（否则 c  later 重放旧本体会导致被删实体复活）。
 * - vv 为空（一台全新设备、尚不知任何客户端）→ W = 0，不裁任何墓碑。
 *
 * 阈值策略：
 * - 仅当当前墓碑总数 > `maxTombstones` 时才动手；阈值内一律不裁（保持墓碑完整）。
 * - 超限时**只在安全集合（lamport ≤ W）内**按「最老优先」裁到 `maxTombstones`；
 *   不安全的墓碑即使超阈值也绝不裁。若安全集合不够，宁可保留超阈值也不越安全线。
 *
 * 幂等与收敛：
 * - 纯函数，返回新文档（不改入参）；对同一状态重复裁剪结果不变。
 * - 裁剪后再 `mergeSnapshots` 一份「仍含该删除墓碑」的远端状态：merge.ts 在
 * 「两侧都不在数组里」分支会把远端墓碑重新合并回来（tombB 传播），因此不会复活、
 * 也不产生假冲突；删除-新建二义场景由 merge 的 LWW 自然收敛。
 */

/** 裁剪阈值默认值（墓碑条数）。 */
export const DEFAULT_MAX_TOMBSTONES = 1000;

export interface PruneTombstonesOptions {
  /**
   * 墓碑数量上限。当前墓碑数 ≤ 该值时不裁；超出时仅在安全集合内按最老优先裁到该值。
   * 非正/非有限值按默认值处理（坏输入不抛）。默认 {@link DEFAULT_MAX_TOMBSTONES}。
   */
  maxTombstones?: number;
}

export interface PruneTombstonesResult {
  /** 裁剪后的新文档（纯函数，不改入参）。未触发裁剪时返回同一引用。 */
  doc: KBNoteDoc;
  /** 被裁掉的节点 id（按裁剪顺序：最老优先）。 */
  prunedNodes: string[];
  /** 被裁掉的边 id（按裁剪顺序：最老优先）。 */
  prunedEdges: string[];
  /** 实际裁剪条数 = prunedNodes.length + prunedEdges.length。 */
  prunedCount: number;
  /** 安全水位 W = min(vv[c])。lamport ≤ W 的墓碑被判定为全部已知客户端已观测。 */
  watermark: number;
  /** 裁剪后仍保留的墓碑总数。 */
  retainedCount: number;
}

interface TombCandidate {
  kind: 'node' | 'edge';
  id: string;
  mark: FMarkTuple;
}

/**
 * 计算安全水位：min over vv 的取值。vv 空或全为非数 → 0（不裁任何东西）。
 * 取整数下限（Lamport 本来就是非负整数）。
 */
export function safeTombstoneWatermark(vv: Record<string, number> | undefined | null): number {
  let min = Infinity;
  if (vv) {
    for (const v of Object.values(vv)) {
      if (typeof v === 'number' && Number.isFinite(v) && v < min) min = v;
    }
  }
  if (min === Infinity) return 0;
  return Math.floor(min);
}

/** 收集 sync 块里全部墓碑（节点 + 边）。 */
function collectTombstones(sync: SyncBlock): TombCandidate[] {
  const out: TombCandidate[] = [];
  const nodes = sync.nodes ?? {};
  const edges = sync.edges ?? {};
  for (const [id, meta] of Object.entries(nodes)) {
    const t = (meta as EntitySyncMeta | undefined)?.t;
    if (t) out.push({ kind: 'node', id, mark: t });
  }
  for (const [id, meta] of Object.entries(edges)) {
    const t = (meta as EntitySyncMeta | undefined)?.t;
    if (t) out.push({ kind: 'edge', id, mark: t });
  }
  return out;
}

/** 最老优先排序：lamport 升序；同 lamport 按 clientId 升序（与 merge 的确定性全序一致）。 */
function byOldest(a: TombCandidate, b: TombCandidate): number {
  if (a.mark[0] !== b.mark[0]) return a.mark[0] - b.mark[0];
  if (a.mark[1] === b.mark[1]) return 0;
  return a.mark[1] < b.mark[1] ? -1 : 1;
}

/**
 * 裁剪墓碑（纯函数）。
 * @param doc 待裁剪的 v3 文档
 * @param options.maxTombstones 墓碑数量上限（默认 1000）
 */
export function pruneTombstones(
  doc: KBNoteDoc,
  options: PruneTombstonesOptions = {},
): PruneTombstonesResult {
  const requested = options.maxTombstones;
  // 允许 0（= 裁掉全部安全墓碑）；仅拒绝负数 / 非有限值。
  const maxTombstones =
    typeof requested === 'number' && Number.isFinite(requested) && requested >= 0
      ? Math.floor(requested)
      : DEFAULT_MAX_TOMBSTONES;

  const sync: SyncBlock = doc.sync ?? emptySyncBlock();
  const vv = (sync.vv ?? {}) as Record<string, number>;
  const watermark = safeTombstoneWatermark(vv);

  const candidates = collectTombstones(sync);
  const total = candidates.length;

  const unchanged = (): PruneTombstonesResult => ({
    doc,
    prunedNodes: [],
    prunedEdges: [],
    prunedCount: 0,
    watermark,
    retainedCount: total,
  });

  // 阈值内不裁。
  if (total <= maxTombstones) return unchanged();

  // 仅安全集合（lamport ≤ watermark）可裁，按最老优先。
  const eligible = candidates
    .filter((c) => c.mark[0] <= watermark)
    .sort(byOldest);

  const need = total - maxTombstones;
  const toPrune = eligible.slice(0, need);
  if (toPrune.length === 0) return unchanged();

  // 构造新 sync（浅拷贝 record，只删除被裁 key；不动其它 meta 本体）。
  const newNodes: Record<string, EntitySyncMeta> = { ...(sync.nodes ?? {}) };
  const newEdges: Record<string, EntitySyncMeta> = { ...(sync.edges ?? {}) };
  const prunedNodes: string[] = [];
  const prunedEdges: string[] = [];
  for (const c of toPrune) {
    if (c.kind === 'node') {
      delete newNodes[c.id];
      prunedNodes.push(c.id);
    } else {
      delete newEdges[c.id];
      prunedEdges.push(c.id);
    }
  }

  const newSync: SyncBlock = {
    vv: { ...vv },
    docF: sync.docF,
    pageF: sync.pageF,
    nodes: newNodes,
    edges: newEdges,
  };
  // 空集合不落 key，保持形状干净（与 merge 产出一致）。
  if (Object.keys(newNodes).length === 0) delete newSync.nodes;
  if (Object.keys(newEdges).length === 0) delete newSync.edges;

  const newDoc: KBNoteDoc = { ...doc, sync: newSync };
  return {
    doc: newDoc,
    prunedNodes,
    prunedEdges,
    prunedCount: toPrune.length,
    watermark,
    retainedCount: total - toPrune.length,
  };
}
