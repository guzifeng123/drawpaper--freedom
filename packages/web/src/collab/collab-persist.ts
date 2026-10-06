import Dexie, { type Table } from 'dexie';
import type { PersistedCollabMeta } from '@drawpaper/core';

/**
 * collab-persist.ts —— 同浏览器协作元数据的独立持久化通道。
 *
 * 为什么独立成库（不动 src/sync、不动 storage/db.ts）：
 *  - 这是「同浏览器多标签」的运行时协作元数据（字段时钟 / 版本向量 / 寄存器墓碑 / op 水位），
 *    与 schema v3 跨设备同步（.kbnote 内的 doc.sync.vv / mergeSnapshots）是两套完全独立的水位。
 *  - 刻意开一个**独立 IndexedDB 数据库** `drawpaper-collab-persist-v1`，键 = docId：
 *    不写进 docs 表、不写进 .kbnote 文件、不进 sync 目录，从物理上与跨设备同步契约隔离，
 *    跨设备 mergeSnapshots 永远看不到这些字段，不污染同步语义。
 *  - doc 本体仍由文档主存储通道（Dexie docs / .kbnote）负责；这里只存「怎么合并」的元数据。
 *
 * 兼容性：旧文档没有这一行 → loadCollabMeta 返回 null → CollabManager 回退
 * createCollabState 的 lamport=0 播种（现状），行为不变。
 */

interface CollabMetaRow extends PersistedCollabMeta {
  /** 主键 = docId（PersistedCollabMeta.docId 即主键）。 */
  id: string;
}

class CollabPersistDB extends Dexie {
  meta!: Table<CollabMetaRow, string>;

  constructor() {
    super('drawpaper-collab-persist-v1');
    this.version(1).stores({
      meta: 'id, docId, savedAt',
    });
  }
}

const db = new CollabPersistDB();

/** 保存某文档的协作元数据（覆盖写）。失败静默（隐私模式 / 配额）。 */
export async function saveCollabMeta(row: PersistedCollabMeta): Promise<void> {
  try {
    await db.meta.put({ ...row, id: row.docId });
  } catch (e) {
    console.warn('[collab-persist] save 失败', e);
  }
}

/** 读取某文档的协作元数据；无 / 损坏返回 null（调用方回退 lamport=0 播种）。 */
export async function loadCollabMeta(docId: string): Promise<PersistedCollabMeta | null> {
  try {
    const row = await db.meta.get(docId);
    if (!row) return null;
    // hydrateCollabMeta 内部会做结构/版本/docId 校验；这里原样交回。
    const { id: _omit, ...rest } = row;
    return rest as PersistedCollabMeta;
  } catch (e) {
    console.warn('[collab-persist] load 失败', e);
    return null;
  }
}

/** 删除文档时清理其协作元数据（best-effort）。 */
export async function clearCollabMeta(docId: string): Promise<void> {
  try {
    await db.meta.delete(docId);
  } catch {
    /* ignore */
  }
}
