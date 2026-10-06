import type { KBNoteDoc } from '@drawpaper/core';
import { manifestFromDoc, type DocManifest } from '@drawpaper/core';

/**
 * .kbpack 备份包内的 manifest.json 形状与导入合并决策（纯函数）。
 *
 * 包内布局：
 *   manifest.json            —— 全部文档清单 + 每文档 vv / 墓碑 / 资产清单（保证 mergeSnapshots 语义）
 *   docs/<docId>.kbnote      —— 文档本体（UTF-8 JSON，与 FSA/WebDAV 通道同格式）
 *   assets/<assetRef>        —— 文档引用的二进制资产（原样字节）
 *
 * 「导入并合并」绝不整包覆盖：逐文档走 mergeSnapshots（与在线通道同一合并内核），
 * 包内 manifest 只用于快速决策「新文档直接收 / 已有文档跑合并」。
 */

/** 包内 manifest.json 的格式标识。 */
export const KBPACK_FORMAT = 'kbpack-manifest';
/** manifest.json 结构版本（前向不兼容时 bump）。 */
export const KBPACK_VERSION = 1;

/** 包内单个文档的索引条目。 */
export interface KbpackDocEntry {
  /** docs/ 下的相对文件名。 */
  file: string;
  title: string;
  /** schema 版本（应为 3）。 */
  version: number;
  /** 文档版本向量（mergeSnapshots 用）。 */
  vv: Record<string, number>;
  /** 墓碑集（被删除节点/边，抑制复活）。 */
  tombstones: { nodes: string[]; edges: string[] };
  /** 包内带哪些资产（assets/<ref>）。 */
  assets: string[];
  /** board.updatedAt（展示/排序）。 */
  modifiedAt: number;
}

/** 包内 manifest.json 根。 */
export interface KbpackManifest {
  format: typeof KBPACK_FORMAT;
  version: number;
  createdAt: number;
  deviceId: string;
  docs: Record<string, KbpackDocEntry>;
}

/** 从一组 v3 文档构建包内 manifest（与每文档 .kbnote / assets 一并打包）。 */
export function buildKbpackManifest(docs: KBNoteDoc[], deviceId: string, createdAt = Date.now()): KbpackManifest {
  const out: Record<string, KbpackDocEntry> = {};
  for (const doc of docs) {
    const m: DocManifest = manifestFromDoc(doc);
    out[doc.id] = {
      file: `docs/${doc.id}.kbnote`,
      title: doc.title,
      version: doc.version,
      vv: { ...m.vv },
      tombstones: { nodes: [...m.tombstones.nodes].sort(), edges: [...m.tombstones.edges].sort() },
      assets: [...m.assets].sort(),
      modifiedAt: m.modifiedAt,
    };
  }
  return { format: KBPACK_FORMAT, version: KBPACK_VERSION, createdAt, deviceId, docs: out };
}

/** 单文档导入决策。 */
export type KbpackImportDecision =
  | 'new'    // 本端没有 → 整文档直接收进库
  | 'merge'; // 本端已有 → 走 mergeSnapshots(本端, 包内)，绝不覆盖

export interface KbpackImportPlan {
  /** docId → 决策。 */
  decisions: Record<string, KbpackImportDecision>;
  /** 需要从包内回填的并集资产 ref（本端缺失者）。 */
  missingAssets: string[];
  /** 包内文档总数。 */
  totalDocs: number;
}

/**
 * 导入前的纯决策：本端已有该 docId → merge；本端没有 → new。
 * 不看内容、不落库，只按 docId 是否存在于本端清单划分。
 *（真正的字段级并发判定交给 mergeSnapshots；这里不预判 LWW，避免重复造轮子。）
 */
export function planKbpackImport(
  localDocIds: Set<string>,
  localAssetRefs: Set<string>,
  manifest: KbpackManifest,
): KbpackImportPlan {
  const decisions: Record<string, KbpackImportDecision> = {};
  const missing = new Set<string>();
  for (const [docId, entry] of Object.entries(manifest.docs)) {
    decisions[docId] = localDocIds.has(docId) ? 'merge' : 'new';
    for (const ref of entry.assets) {
      if (!localAssetRefs.has(ref)) missing.add(ref);
    }
  }
  return {
    decisions,
    missingAssets: [...missing].sort(),
    totalDocs: Object.keys(manifest.docs).length,
  };
}

/** 校验并解析包内 manifest.json 文本；形状不对抛错。 */
export function parseKbpackManifest(text: string): KbpackManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`manifest.json 不是合法 JSON：${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('manifest.json 根节点必须是对象');
  }
  const obj = raw as Record<string, unknown>;
  if (obj['format'] !== KBPACK_FORMAT) {
    throw new Error(`manifest.json format 必须为 "${KBPACK_FORMAT}"`);
  }
  if (typeof obj['docs'] !== 'object' || obj['docs'] === null || Array.isArray(obj['docs'])) {
    throw new Error('manifest.json 缺少 docs 对象');
  }
  return raw as unknown as KbpackManifest;
}
