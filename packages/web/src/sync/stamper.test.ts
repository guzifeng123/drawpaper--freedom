import { describe, it, expect } from 'vitest';
import type { BlockNode, Edge, KBNoteDoc } from '@drawpaper/core';
import { SyncStamper } from './stamper';

function node(partial: Partial<BlockNode> & { id: string }): BlockNode {
  return {
    type: 'text',
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    content: { format: 'tiptap-json', data: { type: 'doc' } },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
    ...partial,
  } as BlockNode;
}

function doc(nodes: BlockNode[], edges: Edge[], title = 't'): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: 3,
    id: 'doc1',
    title,
    board: { createdAt: 0, updatedAt: 0 },
    nodes,
    edges,
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
  } as KBNoteDoc;
}

/** 最小假 store：手动 push (state, prev) 驱动订阅。 */
function makeFakeStore(initial: KBNoteDoc) {
  const listeners = new Set<(s: unknown, p: unknown) => void>();
  const state = { currentDocId: initial.id, doc: initial };
  return {
    state,
    subscribe: (fn: (s: unknown, p: unknown) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getState: () => state,
    push(next: KBNoteDoc) {
      const prev = { ...state };
      state.doc = next;
      state.currentDocId = next.id;
      for (const fn of listeners) fn(state, prev);
    },
  };
}

describe('SyncStamper', () => {
  it('adoptClockFloor 把时钟抬到文档已持久化的最高 lamport', () => {
    const s = new SyncStamper('d_test');
    const d = doc([], []);
    d.sync = { vv: { seed: 50, d_test: 50 }, nodes: { n1: { f: { x: [77, 'seed'] } } } };
    s.adoptFloor(d);
    expect(s.lamport).toBe(77);
  });

  it('本地新增节点 → 落盘盖字段戳 + vv[clientId]', () => {
    const s = new SyncStamper('d_test');
    const empty = doc([], []);
    const store = makeFakeStore(empty);
    s.install(store);
    const withNode = doc([node({ id: 'n1', x: 100 })], []);
    store.push(withNode);
    const out = s.stampForPersist(withNode);
    expect(out.sync.vv['d_test']).toBeGreaterThan(0);
    expect(out.sync.nodes?.['n1']?.f?.['x']).toEqual([expect.any(Number), 'd_test']);
    expect(out.sync.nodes?.['n1']?.f?.['x']![0]).toBeGreaterThan(0);
  });

  it('移动节点只盖变化字段（x），不盖未改字段（y）', () => {
    const s = new SyncStamper('d_test');
    const d0 = doc([node({ id: 'n1', x: 0, y: 0 })], []);
    const store = makeFakeStore(d0);
    s.install(store);
    const d1 = doc([node({ id: 'n1', x: 200, y: 0 })], []);
    store.push(d1);
    const out = s.stampForPersist(d1);
    expect(out.sync.nodes?.['n1']?.f?.['x']).toBeDefined();
    expect(out.sync.nodes?.['n1']?.f?.['y']).toBeUndefined();
  });

  it('删除节点 → 写墓碑 t（不复活）', () => {
    const s = new SyncStamper('d_test');
    const d0 = doc([node({ id: 'n1' })], []);
    const store = makeFakeStore(d0);
    s.install(store);
    const d1 = doc([], []);
    store.push(d1);
    const out = s.stampForPersist(d1);
    expect(out.sync.nodes?.['n1']?.t).toEqual([expect.any(Number), 'd_test']);
  });

  it('远端合并落库期间（applyingRemote>0）不盖章', () => {
    const s = new SyncStamper('d_test');
    const d0 = doc([node({ id: 'n1' })], []);
    const store = makeFakeStore(d0);
    s.install(store);
    s.beginRemoteApply();
    const d1 = doc([node({ id: 'n1', x: 999 })], []);
    store.push(d1);
    s.endRemoteApply(d1);
    // endRemoteApply 清空累加器 → stampForPersist 无戳。
    const out = s.stampForPersist(d1);
    expect(out.sync.vv['d_test'] ?? 0).toBe(0);
  });

  it('文档改名 → docF.title 盖戳', () => {
    const s = new SyncStamper('d_test');
    const d0 = doc([], [], '旧名');
    const store = makeFakeStore(d0);
    s.install(store);
    const d1 = doc([], [], '新名');
    store.push(d1);
    const out = s.stampForPersist(d1);
    expect(out.sync.docF?.['title']).toEqual([expect.any(Number), 'd_test']);
  });
});
