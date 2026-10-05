import type { KBNoteDoc } from '@drawpaper/core';
import { db } from '@/storage/db';
import type { OverviewProvider } from './types';

/**
 * Dexie 只读 OverviewProvider：读取 docs 表全部文档。
 * 只读 import storage/db，不写表、不改表结构。
 */
export class DexieOverviewProvider implements OverviewProvider {
  async loadAllDocs(): Promise<KBNoteDoc[]> {
    return db.docs.orderBy(':id').toArray();
  }
}
