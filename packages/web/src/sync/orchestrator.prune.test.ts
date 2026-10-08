import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseKBNote, serializeKBNote } from '@drawpaper/core';
import type { KBNoteDoc } from '@drawpaper/core';

/**
 * Wave20 R 路：web 传输层把 core 的 pruneTombstones 接进 orchestrator.runSync 的
 * 集成测试（fake/in-memory SyncChannel + 内存 Dexie 替身）。
 *
 * 覆盖（硬验收）：
 *  ① >1000 墓碑且 vv 全覆盖 → runSync 后落盘文档墓碑 ≤1000 且计数正确；
 *  ② 落后 client（vv 未越过某删除 lamport）→ 该墓碑保留、宁可超阈值；
 *  ③ 对端仍持墓碑时再 merge → 墓碑恢复但被删实体不复活；
 *  ④ 未触发裁剪时文档墓碑全部保留（no-op，引用稳定语义）；
 *  ⑤ push-only 文档路径也执行裁剪且推送结果正确。
 */

// ---- 内存替身状态（vi.mock 工厂闭包共享）----
const mem = {
  docs: new Map<string, KBNoteDoc>(),
  bases: new Map<string, KBNoteDoc>(),
  conflicts: [] as unknown[],
  currentDocId: null as string | null,
};

vi.mock('@/storage/db', () => ({
  db: {
    docs: {
      toArray: async () => [...mem.docs.values()],
      get: async (id: string) => mem.docs.get(id) ?? undefined,
      put: async (doc: KBNoteDoc) => {
        mem.docs.set(doc.id, doc);
      },
    },
  },
}));

vi.mock('@/store/editor-store', () => ({
  editorStore: {
    getState: () => ({
      currentDocId: mem.currentDocId,
      requestSave: () => {},
      snapshotDoc: async () => {},
      applyRemoteDoc: async () => {},
    }),
  },
  storageAdapter: {
    saveDoc: async (doc: KBNoteDoc) => {
      mem.docs.set(doc.id, doc);
    },
  },
}));

vi.mock('./sync-db', () => ({
  readBase: async (id: string) => mem.bases.get(id) ?? null,
  writeBase: async (id: string, doc: KBNoteDoc) => {
    mem.bases.set(id, doc);
  },
  readSyncState: async () => ({
    id: 'singleton',
    cursor: { vvByDoc: {} },
    lastSyncAt: null,
    pushCount: 0,
    pullCount: 0,
    conflictCount: 0,
  }),
  writeSyncState: async () => {},
  registerConflictCopy: async (row: unknown) => {
    mem.conflicts.push(row);
  },
}));

vi.mock('./device-identity', () => ({
  loadOrCreateDeviceClientId: () => 'test-dev',
}));

vi.mock('./sync-ui-store', () => ({
  useSyncUi: {
    getState: () => ({
      setBusy: () => {},
      clearConflicts: () => {},
      setError: () => {},
      setConflicts: () => {},
      setLastSyncAt: () => {},
      bumpCounts: () => {},
    }),
  },
}));

vi.mock('./stamper', () => ({
  syncStamper: {
    // 测试聚焦裁剪逻辑：盖章恒等（无累加器快路径）。
    stampForPersist: <T extends KBNoteDoc>(doc: T): T => doc,
    beginRemoteApply: () => {},
    endRemoteApply: () => {},
  },
}));

// 导入被测对象（必须在 vi.mock 之后）。
import { runSync } from './orchestrator';

// ---- fake SyncChannel ----
class FakeChannel {
  readonly type = 'folder' as const;
  readonly e2eeActive = false;
  label(): string {
    return 'fake';
  }
  /** docId -> .kbnote 文本（模拟对端落盘）。 */
  remote = new Map<string, string>();
  /** docId -> 推送出去的 .kbnote 文本。 */
  pushed = new Map<string, string>();
  async listRemoteDocs(): Promise<string[]> {
    return [...this.remote.keys()].map((k) => `${k}.kbnote`);
  }
  async listRemoteAssets(): Promise<string[]> {
    return [];
  }
  async pullDoc(id: string): Promise<string | null> {
    return this.remote.get(id) ?? null;
  }
  async pushDoc(id: string, contents: string): Promise<void> {
    this.pushed.set(id, contents);
  }
  async pullAsset(): Promise<Uint8Array | null> {
    return null;
  }
  async pushAsset(): Promise<void> {}
  async writeConfcted(name: string, contents: string): Promise<void> {
    mem.conflicts.push({ name, contents });
  }
}

// ---- 文档构造工具 ----
function baseDoc(id: string): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: 4,
    id,
    title: 't',
    board: { createdAt: 0, updatedAt: 0 },
    nodes: [],
    edges: [],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: {
      size: 'A4',
      orientation: 'portrait',
      marginMm: 15,
      mode: 'fit',
      showPageBreak: true,
      colorMode: 'color',
      header: false,
      footer: false,
      showPageNumbers: false,
      edgeLabels: true,
      pageBreaks: [],
    },
    assetRefs: [],
    links: [],
    sync: { vv: {} },
  } as unknown as KBNoteDoc;
}

/** 造一份「全部节点都被删、只留墓碑」的文档。 */
function tombDoc(
  id: string,
  vv: Record<string, number>,
  range: Array<[number, string]>,
): KBNoteDoc {
  const doc = baseDoc(id);
  const nodes: Record<string, { t: [number, string] }> = {};
  for (const [lamport, client] of range) {
    nodes[`n${lamport}`] = { t: [lamport, client] };
  }
  doc.sync = { vv, nodes };
  return doc;
}

/** 统计文档里现存的墓碑 id（节点）。 */
function tombIds(doc: KBNoteDoc): string[] {
  const nodes = doc.sync?.nodes ?? {};
  return Object.keys(nodes).filter((k) => nodes[k]?.t);
}

beforeEach(() => {
  mem.docs.clear();
  mem.bases.clear();
  mem.conflicts.length = 0;
  mem.currentDocId = null;
});

describe('orchestrator 墓碑水位裁剪接线（Wave20 R 路）', () => {
  it('① vv 全覆盖时：>1000 墓碑落盘后压到 ≤1000，最老优先、计数正确', async () => {
    const channel = new FakeChannel();
    // 远端 1200 条墓碑，lamport 1..1200，vv={A:1500} → W=1500，全部安全。
    const remote = tombDoc('t1', { A: 1500 }, Array.from({ length: 1200 }, (_, i) => [i + 1, 'A'] as [number, string]));
    channel.remote.set('t1', serializeKBNote(remote));
    // 本地无此文档 → pull-only 路径（merge 收敛后落盘）。

    const r = await runSync(channel);
    expect(r.merged).toBe(1);
    expect(r.prunedTombstones).toBe(200);
    expect(r.prunedEdgeTombstones).toBe(0);
    expect(r.retainedTombstones).toBe(1000);

    const saved = mem.docs.get('t1');
    expect(saved).toBeDefined();
    const ids = new Set(tombIds(saved!));
    expect(ids.size).toBe(1000);
    // 最老 200 条（n1..n200）被裁；其余保留。
    expect(ids.has('n1')).toBe(false);
    expect(ids.has('n200')).toBe(false);
    expect(ids.has('n201')).toBe(true);
    expect(ids.has('n1200')).toBe(true);
  });

  it('② 存在落后 client（vv 未越过删除 lamport）→ 不安全墓碑保留，宁可超阈值', async () => {
    const channel = new FakeChannel();
    // vv={A:1500, B:10} → W=min=10。lamport>10 的墓碑（n11..n1200）对 B 不安全。
    const remote = tombDoc('t2', { A: 1500, B: 10 }, Array.from({ length: 1200 }, (_, i) => [i + 1, 'A'] as [number, string]));
    channel.remote.set('t2', serializeKBNote(remote));

    const r = await runSync(channel);
    // 安全集合仅 n1..n10（10 条），need=200 但只能裁 10 条 → 宁可超阈值。
    expect(r.prunedTombstones).toBe(10);
    expect(r.retainedTombstones).toBe(1190);

    const saved = mem.docs.get('t2')!;
    const ids = new Set(tombIds(saved));
    expect(ids.size).toBe(1190); // >1000，安全集合不够时不越线
    expect(ids.has('n1')).toBe(false); // 最老安全条被裁
    expect(ids.has('n10')).toBe(false);
    expect(ids.has('n11')).toBe(true); // L=11 > W=10，保留
  });

  it('③ 对端仍持墓碑时再 merge → 墓碑恢复但被删实体不复活', async () => {
    const channel = new FakeChannel();
    // 本地（已裁掉 n1）：vv={A:2000}，墓碑 n2..n1000（999 条）。
    const local = tombDoc('t3', { A: 2000 }, Array.from({ length: 999 }, (_, i) => [i + 2, 'A'] as [number, string]));
    mem.docs.set('t3', local);
    // 对端仍持 n1：vv={A:2000, B:1}（并发），墓碑 n1..n1000（1000 条）。
    const remote = tombDoc('t3', { A: 2000, B: 1 }, Array.from({ length: 1000 }, (_, i) => [i + 1, 'A'] as [number, string]));
    channel.remote.set('t3', serializeKBNote(remote));

    const r = await runSync(channel);
    // 合并并集 n1..n1000 = 1000 条 ≤ 阈值 → 不触发裁剪（no-op）。
    expect(r.merged).toBe(1);
    expect(r.prunedTombstones).toBe(0);

    const saved = mem.docs.get('t3')!;
    const ids = new Set(tombIds(saved));
    expect(ids.size).toBe(1000);
    // n1 墓碑由对端自然带回（恢复）。
    expect(ids.has('n1')).toBe(true);
    // 被删实体 n1 不复活进 nodes 数组。
    expect(saved.nodes.map((n) => n.id)).not.toContain('n1');
    expect(saved.nodes.length).toBe(0);
  });

  it('④ 未触发裁剪（≤阈值）→ 墓碑全部保留，计数为 0', async () => {
    const channel = new FakeChannel();
    const remote = tombDoc('t4', { A: 2000 }, Array.from({ length: 500 }, (_, i) => [i + 1, 'A'] as [number, string]));
    channel.remote.set('t4', serializeKBNote(remote));

    const r = await runSync(channel);
    expect(r.prunedTombstones).toBe(0);
    expect(r.retainedTombstones).toBe(500);

    const saved = mem.docs.get('t4')!;
    const ids = new Set(tombIds(saved));
    expect(ids.size).toBe(500);
    expect(ids.has('n1')).toBe(true);
    expect(ids.has('n500')).toBe(true);
  });

  it('⑤ push-only 文档路径也执行裁剪，推送出去的文档墓碑 ≤1000', async () => {
    const channel = new FakeChannel();
    // 本地独有：1200 条安全墓碑，对端无此文档 → push-only。
    const local = tombDoc('t5', { A: 2000 }, Array.from({ length: 1200 }, (_, i) => [i + 1, 'A'] as [number, string]));
    mem.docs.set('t5', local);

    const r = await runSync(channel);
    expect(r.push).toBe(1);
    expect(r.prunedTombstones).toBe(200);
    expect(r.retainedTombstones).toBe(1000);

    const pushedText = channel.pushed.get('t5');
    expect(pushedText).toBeDefined();
    const { doc: pushedDoc } = parseKBNote(pushedText!);
    const ids = new Set(tombIds(pushedDoc));
    expect(ids.size).toBe(1000);
    expect(ids.has('n1')).toBe(false);
    expect(ids.has('n201')).toBe(true);
  });
});
