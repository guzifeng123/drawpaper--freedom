import { nanoid } from 'nanoid';
import { parseKBNote, mergeVersions, type KBNoteDoc } from '@drawpaper/core';
import { db } from '@/storage/db';
import { editorStore, storageAdapter } from '@/store/editor-store';
import { syncStamper } from './stamper';
import {
  listConflictCopies,
  removeConflictCopy,
  type ConflictCopyRow,
} from './sync-db';
import { pushToast } from '@/panels/lib/toast';

/**
 * 冲突副本处理（Wave11 阶段 B）：聚合三来源副本，提供三个确定性动作。
 *
 * 三动作语义：
 *  ① 打开为新文档预览：把副本解析成一份【新 docId】的文档载入浏览（不覆盖原文档）。
 *  ② 以此副本为准（副本胜）：以副本为权威，与当前文档做一次确定性「副本胜」合并后落库。
 *  ③ 丢弃：删除本端登记；若在线通道仍连着，同时删通道侧副本文件。
 *
 * 「副本胜」纯函数 resolveCopyAsWinner 抽出来单测：副本的正文/节点/边/页面设置全量胜出，
 *  仅把版本向量取并集（避免未来又把已删节点复活）、资产引用取并集（不丢图）。
 */

/**
 * 确定性「副本胜」合并：以 copyDoc 为权威结果。
 * - title / nodes / edges / page / tags / links 全部取副本。
 * - vv 取两端并集（mergeVersions），让后续同步知道副本这一侧的事件已被采纳。
 * - assetRefs 取并集（本端独有但副本没引用的图不丢）。
 * - sync.nodes/edges 元数据取副本的（副本胜字段级），墓碑集并集传播。
 */
export function resolveCopyAsWinner(localDoc: KBNoteDoc, copyDoc: KBNoteDoc): KBNoteDoc {
  const localSync = localDoc.sync ?? { vv: {} };
  const copySync = copyDoc.sync ?? { vv: {} };
  // 墓碑集并集（两侧任一标记删除的 id 都保留墓碑，抑制复活）。
  const nodeMeta = { ...(copySync.nodes ?? {}) };
  for (const [id, meta] of Object.entries(localSync.nodes ?? {})) {
    if (meta?.t && !nodeMeta[id]) nodeMeta[id] = meta;
  }
  const edgeMeta = { ...(copySync.edges ?? {}) };
  for (const [id, meta] of Object.entries(localSync.edges ?? {})) {
    if (meta?.t && !edgeMeta[id]) edgeMeta[id] = meta;
  }

  return {
    ...copyDoc,
    title: copyDoc.title,
    board: {
      createdAt: Math.min(localDoc.board.createdAt, copyDoc.board.createdAt),
      updatedAt: Math.max(localDoc.board.updatedAt, copyDoc.board.updatedAt),
    },
    assetRefs: [...new Set([...localDoc.assetRefs, ...copyDoc.assetRefs])].sort(),
    sync: {
      vv: mergeVersions(localSync.vv ?? {}, copySync.vv ?? {}),
      docF: copySync.docF ?? {},
      pageF: copySync.pageF ?? {},
      nodes: nodeMeta,
      edges: edgeMeta,
    },
  };
}

/** 列出全部冲突副本（供面板渲染）。 */
export async function getConflictCopies(): Promise<ConflictCopyRow[]> {
  return listConflictCopies();
}

/** ① 打开为新文档预览：解析副本，另存为新 docId 后打开（不覆盖原文档）。 */
export async function openConflictCopyAsPreview(copy: ConflictCopyRow): Promise<string> {
  const parsed = parseKBNote(copy.text);
  const doc: KBNoteDoc = parsed.doc;
  doc.id = `preview_${nanoid(8)}`;
  doc.title = `[副本预览] ${doc.title || '未命名'}`;
  doc.board = { createdAt: Date.now(), updatedAt: Date.now() };
  await storageAdapter.saveDoc(doc);
  await editorStore.getState().openDoc(doc.id);
  return doc.id;
}

/**
 * ② 以此副本为准：副本胜合并当前文档后落库。
 * @param onRemoteCleanup 若在线通道连着，删掉通道侧副本文件（folder/webdav 传入）。
 */
export async function adoptConflictCopyAsWinner(
  copy: ConflictCopyRow,
  onRemoteCleanup?: (remoteName: string) => Promise<void>,
): Promise<void> {
  const copyDoc = parseKBNote(copy.text).doc;
  const localDoc = await db.docs.get(copy.docId);
  const active = editorStore.getState().currentDocId === copy.docId;

  let merged: KBNoteDoc;
  if (localDoc) {
    merged = resolveCopyAsWinner(localDoc, copyDoc);
  } else {
    // 本地文档已不存在：直接采纳副本。
    merged = { ...copyDoc };
  }

  if (active) await editorStore.getState().snapshotDoc('采纳冲突副本前');
  await storageAdapter.saveDoc(merged);
  if (active) {
    syncStamper.beginRemoteApply();
    editorStore.getState().applyRemoteDoc(merged);
    syncStamper.endRemoteApply(merged);
  }
  await removeConflictCopy(copy.id);
  if (onRemoteCleanup && copy.remoteName) {
    await onRemoteCleanup(copy.remoteName).catch(() => undefined);
  }
  pushToast('success', `已采纳副本「${copy.title}」为准`);
}

/** ③ 丢弃副本：删登记；可选删通道侧文件。 */
export async function discardConflictCopy(
  copy: ConflictCopyRow,
  onRemoteCleanup?: (remoteName: string) => Promise<void>,
): Promise<void> {
  await removeConflictCopy(copy.id);
  if (onRemoteCleanup && copy.remoteName) {
    await onRemoteCleanup(copy.remoteName).catch(() => undefined);
  }
}
