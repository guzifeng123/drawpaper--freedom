import Dexie, { type Table } from 'dexie';
import type { KBNoteDoc, SyncCursor } from '@drawpaper/core';
import { emptyCursor } from '@drawpaper/core';

/**
 * 同步元数据持久化（Wave10 阶段 B）。
 *
 * 独立 Dexie 库 `drawpaper-sync`（不污染主 db，也不写进 .kbnote 本体）：
 *  - syncBase：每文档「上次收敛点」快照（序列化文本）。mergeSnapshots 传 base
 *    可把「只有一侧改了某字段」判定为快进，消除假冲突。
 *  - syncState：单例——合并水位 cursor、上次同步时间、拉/推计数、待解决冲突数。
 *
 * 凭据（WebDAV 用户名/密码）按红线只放 localStorage，不入此库。
 * 纯本地存储，零网络。
 */

interface SyncBaseRow {
  docId: string;
  /** 收敛点 KBNoteDoc 的序列化 JSON（文本，便于整行读写）。 */
  text: string;
  updatedAt: number;
}

export interface SyncStateRow {
  id: 'singleton';
  cursor: SyncCursor;
  lastSyncAt: number | null;
  pushCount: number;
  pullCount: number;
  conflictCount: number;
}

class SyncDB extends Dexie {
  syncBase!: Table<SyncBaseRow, string>;
  syncState!: Table<SyncStateRow, string>;
  constructor() {
    super('drawpaper-sync');
    this.version(1).stores({
      syncBase: 'docId, updatedAt',
      syncState: 'id',
    });
  }
}

const db = new SyncDB();

/** 读某文档的 base（上次收敛点）；无则 null。 */
export async function readBase(docId: string): Promise<KBNoteDoc | null> {
  const row = await db.syncBase.get(docId);
  if (!row) return null;
  try {
    return JSON.parse(row.text) as KBNoteDoc;
  } catch {
    return null;
  }
}

/** 写某文档的 base（同步收敛后调用）。 */
export async function writeBase(docId: string, doc: KBNoteDoc): Promise<void> {
  await db.syncBase.put({ docId, text: JSON.stringify(doc), updatedAt: Date.now() });
}

/** 删除某文档的 base（文档被删时清理）。 */
export async function clearBase(docId: string): Promise<void> {
  await db.syncBase.delete(docId);
}

/** 读单例同步状态；缺省返回空 cursor。 */
export async function readSyncState(): Promise<SyncStateRow> {
  const row = await db.syncState.get('singleton');
  if (row) return row;
  return { id: 'singleton', cursor: emptyCursor(), lastSyncAt: null, pushCount: 0, pullCount: 0, conflictCount: 0 };
}

/** 整体写回同步状态。 */
export async function writeSyncState(row: SyncStateRow): Promise<void> {
  await db.syncState.put(row);
}

/** 重置全部同步元数据（停止同步 + 清除凭据时调用）。 */
export async function resetSyncMeta(): Promise<void> {
  await db.syncBase.clear();
  await db.syncState.clear();
}

/** 测试用：直接访问底层 db（e2e 检视）。 */
export function syncMetaDb(): Dexie {
  return db;
}
