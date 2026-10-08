import {
  mergeSnapshots,
  manifestFromDoc,
  planBundle,
  parseKBNote,
  serializeKBNote,
  advanceWatermark,
  emptyCursor,
  pruneTombstones,
  DEFAULT_MAX_TOMBSTONES,
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
  /** 当前通道是否处于端到端加密模式（FSA 恒 false；WebDAV 开口令时 true）。
   *  用于决定 conflicted 副本远端文件名是否带标题——加密时远端文件名不得泄露标题。 */
  readonly e2eeActive: boolean;
  /** 通道目标标签（设置面板展示）。 */
  label(): string;
  /** 列远端 .kbnote 文件相对名（不含 conflicted 副本）。 */
  listRemoteDocs(): Promise<string[]>;
  /** 列远端已有资产 ref 集合（`assets/<ref>` 中的 `<ref>`）。push 前去重基准；
   *  assets/ 目录不存在时返回空数组。 */
  listRemoteAssets(): Promise<string[]>;
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
  /** 本轮成功推送到远端的资产数（全局去重后、本地 OPFS 读取成功并上传成功）。 */
  assetsPushed: number;
  /** 本轮推送失败的资产数（OPFS 缺失或通道上传失败；尽力而为，不阻断文档同步）。 */
  assetsFailed: number;
  // ---- Wave20 R 路：墓碑水位裁剪（本地遗忘，非全局 gc）统计 ----
  /** 本轮被裁剪掉的墓碑总数（节点 + 边）。0 = 未触发裁剪（阈值内 / 无安全集）。 */
  prunedTombstones: number;
  /** 本轮被裁剪掉的边墓碑数（prunedTombstones 的子集，便于观测）。 */
  prunedEdgeTombstones: number;
  /** 裁剪后仍保留的墓碑总数（跨本轮处理的所有文档求和；每文档 = retainedCount）。 */
  retainedTombstones: number;
  /** 本轮最后一次「实际发生裁剪」观测到的安全水位 W = min(合并后 vv[c])（调试观测；未裁剪为 0）。 */
  tombstoneWatermark: number;
}

/**
 * 对单个「本轮收敛后 / 待推送」文档跑一次墓碑水位裁剪（Wave20 R 路接线）。
 *
 * 契约（docs/wave14/tombstone-bounds.md §5）：
 * - 用文档自身合并后的 sync.vv 派生安全水位（W = min(vv[c])），不用任一对端单独 vv；
 * - 纯函数、不改入参；未触发裁剪时返回同一引用（调用方据此可保持引用稳定）；
 * - 裁剪是「本地遗忘」：对端仍持有的墓碑后续 merge 会自然带回（core merge 已固化），
 *   绝不在此处绕过 merge 或做全局宣告。
 *
 * 统计聚合进 result；返回裁剪后文档，供后续 stampForPersist / 落盘 / 推送使用。
 * 调用时机必须在 stampForPersist 之前。
 */
function pruneDocTombstones(doc: KBNoteDoc, result: SyncRunResult): KBNoteDoc {
  const r = pruneTombstones(doc, { maxTombstones: DEFAULT_MAX_TOMBSTONES });
  result.retainedTombstones += r.retainedCount;
  if (r.prunedCount > 0) {
    result.prunedTombstones += r.prunedCount;
    result.prunedEdgeTombstones += r.prunedEdges.length;
    // 水位只在「实际发生裁剪」时记录：未触发裁剪的文档（尤其空 vv 的新文档）
    // 不应把真实裁剪文档的水位覆盖成 0。
    result.tombstoneWatermark = r.watermark;
    // console.debug 级、不弹 UI、不打扰用户；生产构建无此输出。
    console.debug(
      '[sync] tombstone prune',
      { docId: doc.id, pruned: r.prunedCount, retained: r.retainedCount, watermark: r.watermark },
    );
  }
  return r.doc;
}

/**
 * 跑一轮同步。出错时由调用方 toast；本函数把可预期的合并冲突记进结果并抛业务外错误。
 */
export async function runSync(channel: SyncChannel): Promise<SyncRunResult> {
  const ui = useSyncUi.getState();
  ui.setBusy(true);
  ui.clearConflicts();
  ui.setError('');
  const result: SyncRunResult = {
    push: 0,
    pull: 0,
    merged: 0,
    conflicts: 0,
    skipped: 0,
    assetsPushed: 0,
    assetsFailed: 0,
    prunedTombstones: 0,
    prunedEdgeTombstones: 0,
    retainedTombstones: 0,
    tombstoneWatermark: 0,
  };
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
    // Wave20 R 路：盖章/推送前先按合并后文档自身 vv 裁剪墓碑（push-only 文档同样执行）。
    for (const id of bundle.pushDocIds) {
      const raw = await db.docs.get(id);
      if (!raw) continue;
      const doc = pruneDocTombstones(raw, result);
      const stamped = syncStamper.stampForPersist(doc);
      await channel.pushDoc(id, serializeKBNote(stamped));
      await writeBase(id, stamped);
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

      // Wave20 R 路：mergeSnapshots 收敛后、落库/盖章/推送前，用合并后文档自身 sync.vv
      // 裁剪墓碑。裁剪结果替换后续落盘对象（saveDoc / applyRemoteDoc / writeBase）。
      // 注意：绝不在此绕过 merge——被裁墓碑由对端后续 merge 自然带回（core 已固化）。
      merged = pruneDocTombstones(merged, result);

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
        // 命名规则（Wave14）：
        //  - 未加密通道（FSA / 明文 WebDAV）：远端文件名可读，带文档标题，便于人工翻文件；
        //  - 开启 E2EE 的 WebDAV：远端文件名【不得】泄露标题（服务器能看到文件名），
        //    改用 docId 派生名 `<docId>.conflicted-<时间>.kbnote`；文档标题保留在信封密文内。
        //  本地冲突副本注册表仍存展示标题（title 字段，仅本地库，不落远端明文文件名）。
        const copyBase = channel.e2eeActive
          ? `${remoteDoc.id}.conflicted-${nowStamp()}`
          : `${remoteDoc.title || '未命名'}.conflicted-${nowStamp()}`;
        const copyName = `${copyBase}.kbnote`;
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
              // 必须按原 ref 同名落盘（writeAssetToRef）；不能用 putAsset——那会随机生成新 nanoid，
              // 导致画布里 image.src=<ref> 指向不存在的对象（见 opfs.writeAssetToRef 注释）。
              await import('@/storage/opfs').then((m) => m.writeAssetToRef(ref, bytes));
            }
          }
        } catch {
          /* 单个资产失败忽略 */
        }
      }
    }

    // 4d) 资产推送（Wave14 修复「资产只拉不推」）：
    // 本轮收敛的文档集合 = pushDocIds（本端领先/独有）∪ pullIds（对端领先/合并后）。
    // 收集这些文档在本地登记的全部 assetRefs，与远端已有资产清单比对得出对端缺失集，
    // 全局去重后从本地 OPFS 读字节、经 channel.pushAsset 上传。
    // 开启 E2EE 时资产字节在通道层包成加密信封（WebDAV pushAsset 已实现，这里只负责接通）。
    // 单个资产失败尽力而为、不阻断文档同步（与 4c 容错风格一致），计数可观测。
    await pushMissingAssets(channel, result, new Set([...bundle.pushDocIds, ...pullIds]));

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

/**
 * 资产推送（Wave14）：把本轮收敛文档引用、但远端仍缺失的资产上传。
 *
 * 去重/缺失集算法：
 *  1. 遍历 docIds（= 本轮 pushDocIds ∪ pullIds 合并结果），从本地库读出每篇文档的
 *     assetRefs，并入一个全局 Set（跨文档同 ref 自动去重）；
 *  2. 调 channel.listRemoteAssets() 得远端已有 ref 集合（FSA 递归列 assets/，WebDAV
 *     PROPFIND assets/ 子目录）；
 *  3. missing = 本地 refs − 远端 refs；
 *  4. 逐个 missing：从本地 OPFS 读字节（动态 import，与 4c 同款），读不到记一次失败、
 *     不阻断；读到则 channel.pushAsset(ref, bytes)（WebDAV 开启 E2EE 时通道层包信封）。
 *
 * 合并后文档资产如何纳入：pullIds 在 4b 已 mergeSnapshots 落库，其 assetRefs 是合并后的
 * 并集；故对端带来的文档若引用了「本端才有」的资产（如 B 本地后加的图），也会在这一步
 * 被反向推回远端，实现双向收敛。
 *
 * 孤儿资产（文档删除后无人引用的 ref）本波不做 GC，保守保留，详见 docs/wave14/asset-push.md。
 */
async function pushMissingAssets(
  channel: SyncChannel,
  result: SyncRunResult,
  docIds: Set<string>,
): Promise<void> {
  // 1) 收集本地本轮收敛文档引用的全部资产 ref（全局去重）。
  const localRefs = new Set<string>();
  for (const id of docIds) {
    const doc = await db.docs.get(id);
    if (!doc) continue;
    for (const ref of doc.assetRefs) localRefs.add(ref);
  }
  if (localRefs.size === 0) return;

  // 2) 远端已有资产清单（列举失败/目录不存在一律视为空，不阻断本轮文档同步）。
  let remoteRefs: Set<string>;
  try {
    remoteRefs = new Set(await channel.listRemoteAssets());
  } catch {
    remoteRefs = new Set();
  }

  // 3) 对端缺失集。
  const missing = [...localRefs].filter((ref) => !remoteRefs.has(ref));
  if (missing.length === 0) return;

  // 4) 逐个上传（尽力而为）。
  const opfs = await import('@/storage/opfs');
  for (const ref of missing) {
    try {
      const blob = await opfs.getAsset(ref);
      if (!blob) {
        // 文档登记了 ref 但本地 OPFS 没有字节（罕见：资产被清），跳过并不阻断。
        result.assetsFailed += 1;
        continue;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await channel.pushAsset(ref, bytes);
      result.assetsPushed += 1;
    } catch {
      result.assetsFailed += 1;
    }
  }
}
