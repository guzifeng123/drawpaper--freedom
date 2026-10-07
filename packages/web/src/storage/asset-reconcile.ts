import { isContentHashRef } from '@drawpaper/core';
import { db } from './db';
import {
  getAsset,
  writeAssetToRef,
  sha256Hex,
  blobBytes,
  hasAsset,
  deleteAsset,
} from './opfs';

/**
 * 一次性资产引用迁移（v3 旧 nanoid ref → 内容寻址 hash）。
 *
 * 背景：v3 及以前 putAsset 用随机 nanoid 作文件名；v4 起文件名 = 内容 SHA-256。
 * core 的 v3→v4 迁移只做纯 JSON 规整（去重去空），拿不到字节；字节级重命名必须在
 * web 侧（有 OPFS + Web Crypto）。本模块在启动时跑一次：
 *  1. 遍历全部活动 + 回收站文档，收集「非 64-hex」的 legacy ref；
 *  2. 读 blob → 算 SHA-256 → 把 blob 落到 `<hash>`；
 *  3. 改写该文档的 assetRefs（旧 ref → hash），回写 IndexedDB；
 *  4. 全部处理完后，删除已无任何文档引用的旧 nanoid blob。
 *
 * 幂等：一旦 ref 已是 64-hex（内容 hash）就跳过；重复运行结果不变、不丢资产。
 * 坏输入/缺字节按文档跳过，不阻断启动。
 */

export interface ReconcileSummary {
  /** 处理过的文档数。 */
  docsScanned: number;
  /** 发生了 ref 重命名的文档数。 */
  docsRewritten: number;
  /** 旧 nanoid → 新 hash 的映射条数。 */
  refsRenamed: number;
  /** 删除的旧 nanoid blob 数。 */
  legacyBlobsRemoved: number;
}

/** 把一份文档的 legacy ref 映射成 hash；返回新 assetRefs 与是否有改动。 */
async function rewriteDocRefs(doc: {
  id: string;
  assetRefs: string[];
}): Promise<{ next: string[]; changed: boolean; renameCount: number }> {
  const seen = new Set<string>();
  const next: string[] = [];
  let renameCount = 0;
  let changed = false;

  for (const ref of doc.assetRefs ?? []) {
    if (typeof ref !== 'string' || ref.length === 0) continue;
    if (isContentHashRef(ref)) {
      // 已经是内容寻址：原样保留（去重）。
      if (!seen.has(ref)) {
        seen.add(ref);
        next.push(ref);
      }
      continue;
    }
    // legacy nanoid：读字节算 hash，落到 hash 名下。
    const blob = await getAsset(ref);
    if (!blob) {
      // 字节丢失：保留 ref 占位（避免 assetRefs 与画布引用错位），等同步/回填修复。
      if (!seen.has(ref)) {
        seen.add(ref);
        next.push(ref);
      }
      continue;
    }
    const bytes = await blobBytes(blob);
    const hash = await sha256Hex(bytes);
    if (!(await hasAsset(hash))) {
      await writeAssetToRef(hash, bytes);
    }
    if (!seen.has(hash)) {
      seen.add(hash);
      next.push(hash);
    }
    renameCount += 1;
    changed = true;
  }

  return { next, changed, renameCount };
}

/**
 * 跑一次 reconcile（启动时调用）。返回摘要供 e2e/检视。
 * 失败不抛——任何单文档异常都吞掉，保证启动不被旧档卡死。
 */
export async function reconcileAssetRefs(): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    docsScanned: 0,
    docsRewritten: 0,
    refsRenamed: 0,
    legacyBlobsRemoved: 0,
  };

  // 收集所有文档（活动 + 回收站）。
  const allDocs: Array<{ id: string; assetRefs: string[] }> = [];
  try {
    for (const d of await db.docs.toArray()) {
      allDocs.push({ id: d.id, assetRefs: d.assetRefs ?? [] });
    }
    for (const d of await db.trash.toArray()) {
      allDocs.push({ id: d.id, assetRefs: d.assetRefs ?? [] });
    }
  } catch {
    return summary;
  }

  // 第一遍：改写每份文档的 assetRefs。
  const legacyRefsSeen = new Set<string>(); // 所有出现过的 legacy ref（用于最后清理）
  for (const doc of allDocs) {
    summary.docsScanned += 1;
    try {
      // 记录本份文档里出现过的 legacy ref（清理旧 blob 用）。
      for (const ref of doc.assetRefs ?? []) {
        if (typeof ref === 'string' && !isContentHashRef(ref) && ref.length > 0) {
          legacyRefsSeen.add(ref);
        }
      }
      const { next, changed, renameCount } = await rewriteDocRefs(doc);
      summary.refsRenamed += renameCount;
      if (!changed) continue;
      // 回写对应文档（活动表 / 回收站表）。
      const live = await db.docs.get(doc.id);
      if (live) {
        await db.docs.put({ ...live, assetRefs: next });
      } else {
        const trashed = await db.trash.get(doc.id);
        if (trashed) await db.trash.put({ ...trashed, assetRefs: next });
      }
      summary.docsRewritten += 1;
    } catch {
      /* 单文档失败跳过 */
    }
  }

  // 记录仍被引用的 ref（重写后），用于清理旧 nanoid blob。
  const liveRefsAfter = new Set<string>();
  for (const d of allDocs) {
    const live = await db.docs.get(d.id);
    const row = live ?? (await db.trash.get(d.id));
    if (row) for (const r of row.assetRefs ?? []) liveRefsAfter.add(r);
  }

  // 第二遍：找出「曾经是 legacy、现在已无任何文档引用」的旧 blob，删掉。
  // （blob 名字仍是 nanoid；hash 名下已落新字节。）
  // 为安全，只删「名字不是 64-hex」的孤儿 blob。
  try {
    for (const ref of legacyRefsSeen) {
      if (liveRefsAfter.has(ref)) continue; // 仍被引用，保留
      if (isContentHashRef(ref)) continue;
      await deleteAsset(ref);
      summary.legacyBlobsRemoved += 1;
    }
  } catch {
    /* ignore */
  }

  return summary;
}
