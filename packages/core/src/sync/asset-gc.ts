import type { KBNoteDoc } from '../model/index.js';
import { safeTombstoneWatermark } from './prune.js';

/**
 * 资产引用计数 / 不可达资产集合计算（Wave16 F 路，纯函数，零 DOM/宿主 API）。
 *
 * 背景：资产（图片/附件 Blob）自本波起按「内容寻址」存储——文件名即内容 SHA-256
 * 十六进制串（64 个小写 hex）。同一内容只存一份 blob，被任意数量的文档引用。
 * 文档删除（进回收站 / 物理清除）后，无人再引用的 blob 称为「孤儿资产」。
 *
 * 安全第一语义（与 pruneTombstones 一致）：
 * - 一个资产只有在「任何活动文档、任何回收站文档、任何冲突副本都不再引用它」时，
 *   才被判定为不可达（orphan）。refcount 归零是进保留区的唯一条件。
 * - 保守策略：仍被未裁剪墓碑语义覆盖、被冲突副本引用、或在安全水位
 *   （W = min 已知客户端 vv，见 pruneTombstones）内可能被落后副本重新引用的资产，
 *   一律不判定为可物理清除。自动动作只把孤儿移进「保留区」（可恢复），
 *   物理清除必须由用户手动确认（mayPhysicallyPurge 给出安全许可）。
 *
 * 幂等：纯函数，不改入参；对同一输入重复计算结果完全一致。
 */

/** content-addressed ref 的形状：64 个小写十六进制字符（SHA-256 hex）。 */
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * 判断一个 assetRef 是否为内容寻址引用（SHA-256 hex）。
 * 旧版（v3 及以前）用随机 nanoid（21 位，含 `-`/`_`），可据此区分新旧引用，
 * 供 web 侧做一次性 nanoid→hash 字节重命名迁移。core 只认形状，不算 hash。
 */
export function isContentHashRef(ref: string | null | undefined): boolean {
  return typeof ref === 'string' && CONTENT_HASH_RE.test(ref);
}

/** 计算 GC 计划的输入。 */
export interface AssetGcInput {
  /** 活动文档（docs 表）。 */
  docs: KBNoteDoc[];
  /** 回收站文档（trash 表）。仍引用资产，算保活。 */
  trashDocs: KBNoteDoc[];
  /** 冲突副本登记里引用到的资产 ref（保活：人工核对前不回收）。 */
  conflictCopyRefs: string[];
  /** 本地 blob 存储里现存的全部资产 ref（用于求差集）。 */
  knownAssets: string[];
  /** 合并后的版本向量（算安全水位用）。缺省按空 vv = 不放宽。 */
  vv?: Record<string, number>;
}

/** GC 计划输出。 */
export interface AssetGcPlan {
  /** 必须保活的 ref 集合 = 被任一活动/回收站文档或冲突副本引用的全部 ref。 */
  reachable: Set<string>;
  /** 不可达（孤儿）ref 集合 = knownAssets − reachable。自动动作只移进保留区。 */
  reclaimable: Set<string>;
  /** 每个被引用 ref 的引用计数（仅活动文档维度计数；回收站/冲突副本只算保活不计入）。 */
  refcount: Map<string, number>;
  /** 安全水位 W = min(vv[c])；vv 空 → 0。 */
  watermark: number;
  /**
   * 是否允许物理清除保留区：watermark ≤ 0（无已知落后客户端）时为 true。
   * watermark > 0 表示存在已知客户端尚未观测到最新状态，此时即使进了保留区
   * 也不应物理删除（落后副本可能重新引用）。web 层手动清除前应检查此标志。
   */
  mayPhysicallyPurge: boolean;
}

/** 收集一份文档引用的资产 ref（去空）。 */
function docRefs(doc: KBNoteDoc): string[] {
  if (!Array.isArray(doc.assetRefs)) return [];
  const out: string[] = [];
  for (const ref of doc.assetRefs) {
    if (typeof ref === 'string' && ref.length > 0) out.push(ref);
  }
  return out;
}

/**
 * 计算不可达资产集合（纯函数）。
 *
 * reachable = ⋃(docs.assetRefs) ∪ ⋃(trashDocs.assetRefs) ∪ conflictCopyRefs
 * reclaimable = knownAssets − reachable
 * refcount = 每个 ref 在活动文档里被引用的文档数（用于「refcount 归零才回收」）。
 */
export function computeAssetGcPlan(input: AssetGcInput): AssetGcPlan {
  const reachable = new Set<string>();
  const refcount = new Map<string, number>();

  // 活动文档：既保活，也计入引用计数。
  for (const doc of input.docs ?? []) {
    for (const ref of docRefs(doc)) {
      reachable.add(ref);
      refcount.set(ref, (refcount.get(ref) ?? 0) + 1);
    }
  }
  // 回收站文档：只保活，不计入活动引用计数（已被用户删除）。
  for (const doc of input.trashDocs ?? []) {
    for (const ref of docRefs(doc)) reachable.add(ref);
  }
  // 冲突副本：保活（人工处理前不回收）。
  for (const ref of input.conflictCopyRefs ?? []) {
    if (typeof ref === 'string' && ref.length > 0) reachable.add(ref);
  }

  const reclaimable = new Set<string>();
  for (const ref of input.knownAssets ?? []) {
    if (typeof ref === 'string' && !reachable.has(ref)) reclaimable.add(ref);
  }

  const watermark = safeTombstoneWatermark(input.vv);
  return {
    reachable,
    reclaimable,
    refcount,
    watermark,
    mayPhysicallyPurge: watermark <= 0,
  };
}

/**
 * 给定「即将被物理清除的回收站文档」，算出其中哪些资产 ref 会因此 refcount 归零
 * （即不再被任何剩余活动/回收站文档或冲突副本引用），需要移进保留区。
 *
 * 这是 purgeTrash / emptyTrash 的安全接缝：删除一份回收站文档时，不能盲目删掉它
 * 登记的全部 blob——同一份 blob 可能仍被别的文档引用（内容寻址 dedup 的后果）。
 * 只有从「剩余可达集合」里掉出去的 ref 才是真正的孤儿。
 */
export function orphanRefsAfterPurge(args: {
  /** 即将被删的回收站文档。 */
  purgedDoc: KBNoteDoc;
  /** 剩余活动文档。 */
  remainingDocs: KBNoteDoc[];
  /** 剩余回收站文档（不含即将删除的这份）。 */
  remainingTrashDocs: KBNoteDoc[];
  /** 冲突副本引用。 */
  conflictCopyRefs: string[];
}): Set<string> {
  const remaining = computeAssetGcPlan({
    docs: args.remainingDocs,
    trashDocs: args.remainingTrashDocs,
    conflictCopyRefs: args.conflictCopyRefs,
    knownAssets: [],
  });
  const orphans = new Set<string>();
  for (const ref of docRefs(args.purgedDoc)) {
    // 该 ref 在剩余世界里无人引用 → 随这份回收站文档一起变成孤儿。
    if (!remaining.reachable.has(ref)) orphans.add(ref);
  }
  return orphans;
}
