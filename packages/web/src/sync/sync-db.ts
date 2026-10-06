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
 *  - conflictCopies：跨通道冲突副本注册表（Wave11 阶段 B）——FSA/WebDAV 在线通道
 *    在远端写 `《标题》.conflicted-<时间>.kbnote` 的同时登记一份到这里；手动备份包
 *    通道没有持久远端目录，导入产生的冲突也直接登记。冲突处理面板统一读这张表，
 *    做到刷新后仍在、三来源一处聚合。
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

/** 冲突副本来源通道。 */
export type ConflictSource = 'folder' | 'webdav' | 'manual';

/** 一条冲突副本登记。 */
export interface ConflictCopyRow {
  /** 副本记录 id（= 远端文件名，保证唯一）。 */
  id: string;
  /** 产生该副本的通道。 */
  source: ConflictSource;
  /** 关联文档 id（解析副本 .kbnote 得到）。 */
  docId: string;
  /** 文档标题（列表展示）。 */
  title: string;
  /** 副本 .kbnote 文本本体（供「打开预览 / 以此为准」重读，不必再回远端拉）。 */
  text: string;
  /** 远端文件名（folder/webdav 丢弃时删文件用；manual 为空串）。 */
  remoteName: string;
  createdAt: number;
}

class SyncDB extends Dexie {
  syncBase!: Table<SyncBaseRow, string>;
  syncState!: Table<SyncStateRow, string>;
  conflictCopies!: Table<ConflictCopyRow, string>;
  constructor() {
    super('drawpaper-sync');
    this.version(1).stores({
      syncBase: 'docId, updatedAt',
      syncState: 'id',
    });
    // v2: 冲突副本注册表（Wave11 阶段 B）。
    this.version(2).stores({
      syncBase: 'docId, updatedAt',
      syncState: 'id',
      conflictCopies: 'id, source, docId, createdAt',
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
  await db.conflictCopies.clear();
}

/**
 * 仅清 base 快照（保留计数与水位之外的状态）。
 * Wave11 换口令后调用：让本地每文档都被视为「领先/新增」，下一轮全量重推新口令信封。
 */
export async function clearSyncBase(): Promise<void> {
  await db.syncBase.clear();
}

/** 测试用：直接访问底层 db（e2e 检视）。 */
export function syncMetaDb(): Dexie {
  return db;
}

// ---------------- 冲突副本注册表（Wave11 阶段 B） ----------------

/** 登记一条冲突副本（在线通道写远端副本时同时调用；手动通道导入冲突时直接调）。 */
export async function registerConflictCopy(row: ConflictCopyRow): Promise<void> {
  await db.conflictCopies.put(row);
}

/** 列出全部冲突副本（按时间旧→新）。 */
export async function listConflictCopies(): Promise<ConflictCopyRow[]> {
  const rows = await db.conflictCopies.orderBy('createdAt').toArray();
  return rows;
}

/** 删除一条副本登记；可选地回删通道侧远端文件（由调用方传入）。 */
export async function removeConflictCopy(id: string): Promise<void> {
  await db.conflictCopies.delete(id);
}

/** 清空全部冲突副本登记（停止同步时）。 */
export async function clearConflictCopies(): Promise<void> {
  await db.conflictCopies.clear();
}
