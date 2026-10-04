import Dexie, { type Table } from 'dexie';
import { nanoid } from 'nanoid';
import type { DocMeta, KBNoteDoc, SnapshotMeta, TrashDocMeta } from '@drawpaper/core';
import { pruneSnapshotsToLatest, SNAPSHOT_KEEP } from '@drawpaper/core';
import { deleteAsset, getAsset, putAsset } from './opfs';

/**
 * Dexie/IndexedDB 持久化：
 *  - docs 表：整份文档 JSON（自动保存）。
 *  - snapshots 表：文档历史快照（每文档保留最近 SNAPSHOT_KEEP 条）。
 *  - trash 表：回收站（删除进 trash，可恢复；purge 才物理删除并清理 OPFS 附件）。
 * OPFS 大附件经 opfs.ts 委派（StorageAdapter 的 asset 方法）。
 */

/** 快照行（含文本本体）。 */
interface SnapshotRow {
  id: string;
  docId: string;
  takenAt: number;
  label: string | null;
  text: string;
}

/** 回收站行 = 整份文档 + 被删时间。 */
type TrashRow = KBNoteDoc & { trashedAt: number };

/** docs 表记录 = 完整 KBNoteDoc（索引字段 id / updatedAt / title 供列表排序查询）。 */
class DrawPaperDB extends Dexie {
  docs!: Table<KBNoteDoc, string>;
  snapshots!: Table<SnapshotRow, string>;
  trash!: Table<TrashRow, string>;

  constructor() {
    super('drawpaper-db');
    // v1: docs。v2: 新增 snapshots / trash。
    this.version(1).stores({
      docs: 'id, board.updatedAt, title',
    });
    this.version(2).stores({
      docs: 'id, board.updatedAt, title',
      snapshots: 'id, docId, takenAt',
      trash: 'id, trashedAt, title',
    });
  }
}

export const db = new DrawPaperDB();

/** StorageAdapter 的浏览器（IndexedDB + OPFS）实现。 */
export class DexieStorageAdapter {
  async saveDoc(doc: KBNoteDoc): Promise<void> {
    // 列表按 updatedAt 倒序：每次落盘刷新 board.updatedAt。
    const toSave: KBNoteDoc = {
      ...doc,
      board: { ...doc.board, updatedAt: Date.now() },
    };
    await db.docs.put(toSave);
  }

  async loadDoc(id: string): Promise<KBNoteDoc | null> {
    const rec = await db.docs.get(id);
    return rec ?? null;
  }

  async listDocs(): Promise<DocMeta[]> {
    const recs = await db.docs.orderBy(':id').toArray();
    const metas: DocMeta[] = recs.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.board.updatedAt,
      createdAt: r.board.createdAt,
    }));
    metas.sort((a, b) => b.updatedAt - a.updatedAt);
    return metas;
  }

  /** 删除文档 = 移入回收站（拷入 trash 表并打 trashedAt），不物理删除、不清附件。 */
  async deleteDoc(id: string): Promise<void> {
    const doc = await db.docs.get(id);
    if (!doc) return;
    await db.trash.put({ ...doc, trashedAt: Date.now() });
    await db.docs.delete(id);
  }

  // ---- 附件 ----
  async getAsset(assetRef: string) {
    return getAsset(assetRef);
  }

  async putAsset(blob: Blob) {
    return putAsset(blob);
  }

  async deleteAsset(assetRef: string): Promise<void> {
    return deleteAsset(assetRef);
  }

  // ---- 快照 ----
  async saveSnapshot(docId: string, label: string | null, text: string): Promise<SnapshotMeta> {
    const row: SnapshotRow = { id: 's_' + nanoid(), docId, takenAt: Date.now(), label, text };
    await db.snapshots.put(row);
    // 淘汰：每文档只保留最近 N 条。
    const all = await db.snapshots.where('docId').equals(docId).toArray();
    const keep = pruneSnapshotsToLatest(all, SNAPSHOT_KEEP);
    const keepIds = new Set(keep.map((r) => r.id));
    const stale = all.filter((r) => !keepIds.has(r.id)).map((r) => r.id);
    if (stale.length > 0) await db.snapshots.bulkDelete(stale);
    const { text: _omit, ...meta } = row;
    return meta;
  }

  async listSnapshots(docId: string): Promise<SnapshotMeta[]> {
    const rows = await db.snapshots.where('docId').equals(docId).toArray();
    rows.sort((a, b) => b.takenAt - a.takenAt);
    return rows.map(({ text: _omit, ...meta }) => meta);
  }

  async getSnapshot(id: string) {
    return (await db.snapshots.get(id)) ?? null;
  }

  async deleteSnapshot(id: string): Promise<void> {
    await db.snapshots.delete(id);
  }

  // ---- 回收站 ----
  async listTrash(): Promise<TrashDocMeta[]> {
    const rows = await db.trash.orderBy('trashedAt').reverse().toArray();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.board.updatedAt,
      createdAt: r.board.createdAt,
      trashedAt: r.trashedAt,
    }));
  }

  async restoreFromTrash(id: string): Promise<void> {
    const row = await db.trash.get(id);
    if (!row) return;
    const { trashedAt: _omit, ...doc } = row;
    await db.docs.put(doc);
    await db.trash.delete(id);
  }

  /** 物理删除回收站一份文档，并清理其 OPFS 附件。 */
  async purgeTrash(id: string): Promise<void> {
    const row = await db.trash.get(id);
    if (row) await this.purgeAssets(row.assetRefs);
    await db.trash.delete(id);
  }

  async emptyTrash(): Promise<void> {
    const rows = await db.trash.toArray();
    for (const row of rows) await this.purgeAssets(row.assetRefs);
    await db.trash.clear();
  }

  private async purgeAssets(assetRefs: string[]): Promise<void> {
    await Promise.all(assetRefs.map((ref) => deleteAsset(ref)));
  }
}
