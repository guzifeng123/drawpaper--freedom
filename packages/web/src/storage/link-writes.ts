import type { KBNoteDoc } from '@drawpaper/core';
import {
  extractDocLinks,
  retitleDocRefMarks,
  stripDocRefMarks,
  serializeKBNote,
} from '@drawpaper/core';
import { db } from './db';
import { storageAdapter } from '@/store/editor-store';
import { extractPlainText } from './search-index';

/**
 * Wave7 P2.1 跨文档链接级联写路径。
 *
 * 背景：当前文档内的变更走 core Command/macro（可撤销）；
 * 但「其他 Dexie 文档里的源 mark」不在当前文档的 undo 栈内——
 * 对它们的修改是存储层直写。为不静默丢链，每次直写前对被改文档拍快照
 * （复用 snapshots 表 / saveSnapshot 机制），用户可经快照恢复整份文档。
 *
 * 本模块只做「load → core 纯函数变换 → 重建 links → saveDoc」，无 DOM。
 */

/** 对一份文档先拍快照再变换落盘；返回是否真的改了。 */
async function snapshotThenTransform(
  doc: KBNoteDoc,
  label: string,
  transform: (d: KBNoteDoc) => { doc: KBNoteDoc; count: number },
): Promise<boolean> {
  const { doc: next, count } = transform(doc);
  if (count === 0) return false;
  // 写快照：保存变换前的原文，供快照恢复。失败不阻塞主流程（与 takeSnapshot 同策略）。
  try {
    await storageAdapter.saveSnapshot?.(doc.id, label, serializeKBNote(doc));
  } catch {
    /* 快照失败仍继续落盘（降级为不可恢复，但不丢本次级联结果） */
  }
  // 变换后重建规范化反链索引（与 flushSave 同口径：mark 是主存，links 是索引）。
  const links = extractDocLinks(next.id, next.nodes, { existingLinks: next.links ?? [] });
  await storageAdapter.saveDoc({ ...next, links });
  return true;
}

/**
 * 级联移除：把指向/发自待删块的 docRef mark 从「其他文档」里剥掉。
 * @param removeLinkIds 影响分析给出的待移除 link id 集合（四元组派生，与 core 同口径）。
 * @param exceptDocId   当前文档——其同文档 mark 由 store macro 在内存里撤销处理，不走这里。
 * @returns 实际被改写的文档数。
 */
export async function cascadeRemoveLinksAcrossDocs(
  removeLinkIds: ReadonlySet<string>,
  exceptDocId: string,
): Promise<number> {
  if (removeLinkIds.size === 0) return 0;
  let all: KBNoteDoc[] = [];
  try {
    all = await db.docs.toArray();
  } catch {
    return 0;
  }
  let changed = 0;
  for (const doc of all) {
    if (doc.id === exceptDocId) continue;
    const did = await snapshotThenTransform(doc, '删除块前·移除引用', (d) =>
      stripDocRefMarks(d, removeLinkIds),
    );
    if (did) changed++;
  }
  return changed;
}

/**
 * 重命名批量回写：目标块改名后，把所有源文档里指向它的 docRef mark
 * （可见文本 + attrs.targetTitle + links 索引）刷新为新标题。
 * @param exceptDocId 当前文档——其内存内 mark 由 web 走 store 命令回写（保持 undo 一致），
 *   这里跳过，避免内存态把存储态覆盖回去。
 * @returns 实际被改写的文档数。
 */
export async function retitleAcrossDocs(
  targetDocId: string,
  targetNodeId: string,
  newTitle: string,
  exceptDocId?: string,
): Promise<number> {
  let all: KBNoteDoc[] = [];
  try {
    all = await db.docs.toArray();
  } catch {
    return 0;
  }
  let changed = 0;
  for (const doc of all) {
    if (doc.id === exceptDocId) continue;
    const did = await snapshotThenTransform(doc, '重命名目标·同步引用', (d) =>
      retitleDocRefMarks(d, targetDocId, targetNodeId, newTitle),
    );
    if (did) changed++;
  }
  return changed;
}

/**
 * 保存后对账：当前文档刚存盘。指向本文档块的 incoming 链接分散在「各源文档」的
 * links 里（doc.links 只记录本文档的出链），因此要扫全量 Dexie 文档，
 * 找出 targetDocId === 当前文档 且 link.targetTitle 快照与块当前纯文本首行不一致的
 * 记录（即目标块被改名），对受影响的目标块做一次跨文档重命名回写。
 *
 * @returns 检测到的重命名（targetNodeId → 新标题），供 web 对当前文档内存态做同款回写。
 */
export async function syncBacklinkTitles(
  currentDoc: KBNoteDoc,
): Promise<Map<string, string>> {
  const plainByNode = new Map<string, string>();
  for (const n of currentDoc.nodes) {
    const t = extractPlainText(n.content.data);
    if (t) plainByNode.set(n.id, t);
  }
  let all: KBNoteDoc[] = [];
  try {
    all = await db.docs.toArray();
  } catch {
    return new Map();
  }
  // 收集需要重命名的目标块：incoming 链接的 targetTitle 快照与现文本不符。
  const renames = new Map<string, string>(); // targetNodeId → newTitle
  for (const d of all) {
    for (const link of d.links ?? []) {
      if (link.targetDocId !== currentDoc.id) continue;
      const fresh = plainByNode.get(link.targetNodeId);
      if (!fresh) continue; // 目标块被删（悬挂），不在此处理
      if (fresh !== link.targetTitle) renames.set(link.targetNodeId, fresh);
    }
  }
  for (const [nodeId, newTitle] of renames) {
    await retitleAcrossDocs(currentDoc.id, nodeId, newTitle, currentDoc.id);
  }
  return renames;
}
