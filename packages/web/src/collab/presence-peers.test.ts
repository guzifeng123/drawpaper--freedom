import { describe, it, expect } from 'vitest';
import {
  upsertPeer,
  sweepOfflinePeers,
  peersForDoc,
  docsOpenByPeers,
} from './presence-peers';
import type { PresenceState } from '@drawpaper/core';

function presence(docId: string): PresenceState {
  return { docId, selection: [], hoverNodeId: null, blockRect: null, heartbeatSeq: 1 };
}

describe('presence peers 表 + 心跳超时', () => {
  it('upsertPeer 不可变地插入/更新 peer', () => {
    let table = new Map();
    table = upsertPeer(table, { clientId: 'c_a', name: '左屏', color: '#f00', presence: presence('d1'), now: 1000 });
    expect(table.size).toBe(1);
    // 更新同一 peer（新心跳）不改表大小
    table = upsertPeer(table, { clientId: 'c_a', name: '左屏', color: '#f00', presence: presence('d1'), now: 2000 });
    expect(table.size).toBe(1);
    expect(table.get('c_a')!.lastSeenAt).toBe(2000);
  });

  it('超过 timeout 的 peer 被清扫（含异常关闭无 goodbye）', () => {
    let table = new Map();
    table = upsertPeer(table, { clientId: 'c_a', name: 'A', color: '#f00', presence: presence('d1'), now: 0 });
    table = upsertPeer(table, { clientId: 'c_b', name: 'B', color: '#0f0', presence: presence('d1'), now: 6000 });
    const { table: next, removed } = sweepOfflinePeers(table, 9000, 3500);
    expect(removed.map((p) => p.clientId)).toEqual(['c_a']); // c_a 距今9000>3500；c_b 距今3000<=3500
    expect(next.has('c_b')).toBe(true);
    expect(next.has('c_a')).toBe(false);
  });

  it('刚好在超时窗口内不清除', () => {
    let table = new Map();
    table = upsertPeer(table, { clientId: 'c_a', name: 'A', color: '#f00', presence: presence('d1'), now: 1000 });
    const { table: next } = sweepOfflinePeers(table, 4000, 3500); // 差 3000 <= 3500
    expect(next.has('c_a')).toBe(true);
  });

  it('peersForDoc 只返回打开指定文档的 peer', () => {
    let table = new Map();
    table = upsertPeer(table, { clientId: 'a', name: 'A', color: '#1', presence: presence('doc-X'), now: 0 });
    table = upsertPeer(table, { clientId: 'b', name: 'B', color: '#2', presence: presence('doc-Y'), now: 0 });
    expect(peersForDoc(table, 'doc-X').map((p) => p.clientId)).toEqual(['a']);
  });

  it('docsOpenByPeers 汇总每篇文档被哪些 peer 打开', () => {
    let table = new Map();
    table = upsertPeer(table, { clientId: 'a', name: '左', color: '#1', presence: presence('d1'), now: 0 });
    table = upsertPeer(table, { clientId: 'b', name: '右', color: '#2', presence: presence('d1'), now: 0 });
    table = upsertPeer(table, { clientId: 'c', name: '三', color: '#3', presence: presence('d2'), now: 0 });
    const byDoc = docsOpenByPeers(table);
    expect(byDoc.get('d1')!.map((p) => p.name)).toEqual(['左', '右']);
    expect(byDoc.get('d2')!.map((p) => p.clientId)).toEqual(['c']);
  });
});
