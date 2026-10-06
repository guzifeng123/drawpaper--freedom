import {
  mergeSnapshots,
  manifestFromDoc,
  planBundle,
  parseKBNote,
  serializeKBNote,
  advanceWatermark,
  emptyCursor,
  type KBNoteDoc,
  type SyncManifest,
  type CollabConflict,
} from '@drawpaper/core';
import { db } from '@/storage/db';
import { editorStore, storageAdapter } from '@/store/editor-store';
import { syncStamper } from './stamper';
import { loadOrCreateDeviceClientId } from './device-identity';
import { readBase, writeBase, readSyncState, writeSyncState } from './sync-db';
import { registerConflictCopy } from './sync-db';
import { useSyncUi } from './sync-ui-store';

/**
 * 同步编排引擎（Wave10 阶段 B）：两通道（FSA 文件夹 / WebDAV）共用。
 *
 * 一轮同步：
 *  1. 刷盘当前文档（requestSave + 等防抖），读本地全部文档构建 local manifest；
 *  2. 通道列远端 .kbnote → parse → remote manifest；
 *  3. diffManifests/planBundle 定 push/pull/merge；
 *  4. merge：合并前 snapshotDoc('同步合并前') → mergeSnapshots(local, remote, base)
 *     → 落库（非打开文档直接 db.docs.put；打开文档走 applyRemoteDoc，不进 undo）；
 *     冲突 → 横幅 + 写 conflicted 副本；
 *  5. 收敛后推进 cursor、写 base、更新计数。
 *
 * 零托管：本模块不发任何网络；IO 全部经传入的 SyncChannel。
 */

/** 通道抽象：FSA / WebDAV 各自实现同一组读写。 */
export interface SyncChannel {
  readonly type: 'folder' | 'webdav';
  /** 通道目标标签（设置面板展示）。 */
  label(): string;
  /** 列远端 .kbnote 文件相对名（不含 conflicted 副本）。 */
  listRemoteDocs(): Promise<string[]>;
  pullDoc(docId: string): Promise<string | null>;
  pushDoc(docId: string, contents: string): Promise<void>;
  pullAsset(ref: string): Promise<Uint8Array | null>;
  pushAsset(ref: string, bytes: Uint8Array): Promise<void>;
  /** 写 conflicted 副本（标题+时间戳命名）。 */
  writeConfcted(filename: string, contents: string): Promise<void>;
}

const docFileName = (docId: string): string => `${docId}.kbnote`;

function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface SyncRunResult {
  push: number;
  pull: number;
  merged: number;
  conflicts: number;
  skipped: number;
}

/**
 * 跑一轮同步。出错时由调用方 toast；本函数把可预期的合并冲突记进结果并抛业务外错误。
 */
export async function runSync(channel: SyncChannel): Promise<SyncRunResult> {
  const ui = useSyncUi.getState();
  ui.setBusy(true);
  ui.clearConflicts();
  ui.setError('');
  const result: SyncRunResult = { push: 0, pull: 0, merged: 0, conflicts: 0, skipped: 0 };
  try {
    // 1) 刷盘当前文档。
    editorStore.getState().requestSave();
    await new Promise((r) => setTimeout(r, 700));

    // 2) local manifest（从 Dexie 读已盖章文档）。
    const localDocs = await db.docs.toArray();
    const localManifest: SyncManifest = {
      deviceId: loadOrCreateDeviceClientId(),
      docs: {},
    };
    for (const doc of localDocs) {
      localManifest.docs[doc.id] = manifestFromDoc(syncStamper.stampForPersist(doc));
    }

    // 3) remote manifest。
    const remoteNames = await channel.listRemoteDocs();
    const remoteManifest: SyncManifest = { deviceId: 'remote', docs: {} };
    const remoteDocText = new Map<string, string>();
    for (const name of remoteNames) {
      const text = await channel.pullDoc(name.replace(/\.kbnote$/, ''));
      if (text == null) continue;
      try {
        const { doc } = parseKBNote(text);
        remoteDocText.set(doc.id, text);
        remoteManifest.docs[doc.id] = manifestFromDoc(doc);
      } catch {
        // 坏档/高版本：跳过该文件，不阻断其它文档。
        result.skipped += 1;
      }
    }

    const bundle = planBundle(localManifest, remoteManifest);

    // 4a) push：本地独有/领先 → 上传。
    for (const id of bundle.pushDocIds) {
      const doc = await db.docs.get(id);
      if (!doc) continue;
      await channel.pushDoc(id, serializeKBNote(syncStamper.stampForPersist(doc)));
      await writeBase(id, syncStamper.stampForPersist(doc));
      result.push += 1;
    }

    // 4b) pull / merge：远端独有/领先/并发。
    const pullIds = [...bundle.pullDocIds, ...bundle.mergeDocIds];
    for (const id of pullIds) {
      const text = remoteDocText.get(id);
      if (text == null) continue;
      const { doc: remoteDoc } = parseKBNote(text);
      const localDoc = await db.docs.get(id);
      const base = await readBase(id);
      const active = editorStore.getState().currentDocId === id;

      let merged: KBNoteDoc;
      let conflicts: CollabConflict[] = [];
      if (localDoc) {
        // 合并前快照（仅打开文档；回滚到合并前）。
        if (active) await editorStore.getState().snapshotDoc('同步合并前');
        const r = mergeSnapshots(localDoc, remoteDoc, base ?? undefined);
        merged = r.doc;
        conflicts = r.conflicts;
      } else {
        merged = remoteDoc;
      }

      // 落库。
      await storageAdapter.saveDoc(merged);
      if (active) {
        syncStamper.beginRemoteApply();
        editorStore.getState().applyRemoteDoc(merged);
        syncStamper.endRemoteApply(merged);
      }

      await writeBase(id, merged);
      if (conflicts.length > 0) {
        result.conflicts += conflicts.length;
        // 写 conflicted 副本（保留对端版本供人工核对）。
        const copyName = `${remoteDoc.title || '未命名'}.conflicted-${nowStamp()}.kbnote`;
        const copyText = serializeKBNote(remoteDoc);
        await channel.writeConfcted(copyName, copyText);
        // 同时登记到本地冲突副本注册表（冲突处理面板三来源聚合；刷新后仍在）。
        await registerConflictCopy({
          id: copyName,
          source: channel.type,
          docId: remoteDoc.id,
          title: remoteDoc.title || '未命名',
          text: copyText,
          remoteName: copyName,
          createdAt: Date.now(),
        });
        if (active) {
          useSyncUi.getState().setConflicts(
            conflicts.map((c) => c.reason),
          );
        }
      }
      result.merged += 1;
    }

    // 4c) 资产：补拉本地缺失的资产（尽力而为，失败不阻断）。
    for (const id of pullIds) {
      const merged = await db.docs.get(id);
      if (!merged) continue;
      for (const ref of merged.assetRefs) {
        try {
          const bytes = await channel.pullAsset(ref);
          if (bytes) {
            const existing = await import('@/storage/opfs').then((m) => m.getAsset(ref));
            if (!existing) {
              await import('@/storage/opfs').then((m) => m.putAsset(new Blob([bytes])));
            }
          }
        } catch {
          /* 单个资产失败忽略 */
        }
      }
    }

    // 5) 推进 cursor + 计数持久化。
    const state = await readSyncState();
    let cursor = state.cursor ?? emptyCursor();
    for (const id of [...bundle.pushDocIds, ...pullIds]) {
      const merged = await db.docs.get(id);
      if (merged) cursor = advanceWatermark(cursor, merged);
    }
    await writeSyncState({
      ...state,
      cursor,
      lastSyncAt: Date.now(),
      pushCount: state.pushCount + result.push,
      pullCount: state.pullCount + result.merged,
      conflictCount: state.conflictCount + result.conflicts,
    });
    useSyncUi.getState().setLastSyncAt(Date.now());
    useSyncUi.getState().bumpCounts(result.push, result.merged);
    return result;
  } finally {
    ui.setBusy(false);
  }
}

export { docFileName };
