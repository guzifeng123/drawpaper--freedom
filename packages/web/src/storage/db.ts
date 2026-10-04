import Dexie, { type Table } from 'dexie';
import type { DocMeta, KBNoteDoc } from '@drawpaper/core';
import { deleteAsset, getAsset, putAsset } from './opfs';

/**
 * Dexie/IndexedDB 持久化：整份文档 JSON 存 docs 表。
 * OPFS 大附件经 opfs.ts 委派（StorageAdapter 的 asset 方法）。
 */

/** docs 表记录 = 完整 KBNoteDoc（索引字段 id / updatedAt / title 供列表排序查询）。 */
class DrawPaperDB extends Dexie {
  docs!: Table<KBNoteDoc, string>;

  constructor() {
    super('drawpaper-db');
    this.version(1).stores({
      docs: 'id, board.updatedAt, title',
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

  async deleteDoc(id: string): Promise<void> {
    await db.docs.delete(id);
  }

  async getAsset(assetRef: string) {
    return getAsset(assetRef);
  }

  async putAsset(blob: Blob) {
    return putAsset(blob);
  }

  async deleteAsset(assetRef: string): Promise<void> {
    return deleteAsset(assetRef);
  }
}
