import { describe, it, expect } from 'vitest';
import { applyOp } from './merge.js';
import {
  applySnapshot,
  buildSnapshotRequest,
  buildSnapshotResponse,
  pruneTombstones,
  pruneAppliedOps,
  compactCollabState,
} from './snapshot.js';
import { CollabProtocolError } from './envelope.js';
import { header, opEnv, freshState, makeDoc, node } from './test-helpers.js';
import { createCollabState } from './state.js';
import type { CollabState } from './state.js';

const DOC_ID = 'doc_snapshot_test';

/** 模拟持有方 A 的状态：建文档 + 若干 op。 */
function buildPeerState(): CollabState {
  const st = freshState(makeDoc(DOC_ID));
  const docId = st.docId;
  let s = st;
  s = applyOp(s, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('root', 0, 0) })).state;
  s = applyOp(s, opEnv(header(docId, 'c_a', 2), { kind: 'add-node', node: node('child', 100, 0) })).state;
  s = applyOp(s, opEnv(header(docId, 'c_a', 3), { kind: 'update-node', nodeId: 'child', patch: { y: 50 } })).state;
  s = applyOp(s, opEnv(header(docId, 'c_a', 4), { kind: 'set-doc-meta', patch: { title: '已对齐文档' } })).state;
  return s;
}

/** 空 doc 的 late-joiner（与 peer 同 docId）。 */
function emptyJoiner(): CollabState {
  return createCollabState(makeDoc(DOC_ID));
}

describe('late-joiner 快照对齐', () => {
  it('空客户端收到 snapshot 后重放增量，最终与持有方一致', () => {
    const peer = buildPeerState();
    const lateJoiner = emptyJoiner(); // 空 doc

    const req = buildSnapshotRequest({
      docId: lateJoiner.docId, clientId: 'c_b', tabName: '新标签', tabColor: '#f00',
      lamport: 1, requestVv: {},
    });
    const snap = buildSnapshotResponse({
      docId: peer.docId, clientId: 'c_a', tabName: 'A', tabColor: '#0f0', lamport: 5,
      state: peer, requestVv: req.requestVv,
    });
    const res = applySnapshot(lateJoiner, snap);
    expect(res.replayed).toBeGreaterThan(0);
    expect(res.state.doc.nodes.map((n) => n.id).sort()).toEqual(['child', 'root']);
    expect(res.state.doc.title).toBe('已对齐文档');
    expect(res.state.doc.nodes.find((n) => n.id === 'child')!.y).toBe(50);
  });

  it('增量 op 乱序到达也能收敛（按 lamport 重排）', () => {
    const peer = buildPeerState();
    const lateJoiner = emptyJoiner();
    const req = buildSnapshotRequest({
      docId: lateJoiner.docId, clientId: 'c_b', tabName: '新标签', tabColor: '#f00',
      lamport: 1, requestVv: {},
    });
    const snap = buildSnapshotResponse({
      docId: peer.docId, clientId: 'c_a', tabName: 'A', tabColor: '#0f0', lamport: 5,
      state: peer, requestVv: req.requestVv,
    });
    // 人为打乱 ops 顺序
    snap.snapshot.ops = snap.snapshot.ops.slice().reverse() as typeof snap.snapshot.ops;
    const res = applySnapshot(lateJoiner, snap);
    expect(res.state.doc.title).toBe('已对齐文档');
    expect(res.state.doc.nodes.find((n) => n.id === 'child')!.y).toBe(50);
  });

  it('重复/已含 op 幂等跳过', () => {
    const peer = buildPeerState();
    const lateJoiner = emptyJoiner();
    const req = buildSnapshotRequest({
      docId: lateJoiner.docId, clientId: 'c_b', tabName: '新标签', tabColor: '#f00',
      lamport: 1, requestVv: {},
    });
    const snap = buildSnapshotResponse({
      docId: peer.docId, clientId: 'c_a', tabName: 'A', tabColor: '#0f0', lamport: 5,
      state: peer, requestVv: req.requestVv,
    });
    // 故意把 ops 复制一份（内部按 opId 去重）
    const doubled = [...snap.snapshot.ops, ...snap.snapshot.ops] as typeof snap.snapshot.ops;
    snap.snapshot.ops = doubled;
    const res = applySnapshot(lateJoiner, snap);
    expect(res.state.doc.nodes).toHaveLength(2);
  });

  it('坏基线抛 CollabProtocolError 且不动本地状态', () => {
    const lateJoiner = emptyJoiner();
    const snap = buildSnapshotResponse({
      docId: lateJoiner.docId, clientId: 'c_a', tabName: 'A', tabColor: '#0f0', lamport: 5,
      state: lateJoiner, requestVv: {},
    });
    // 破坏基线
    (snap.snapshot as { baseline: unknown }).baseline = { format: 'wrong', version: 99 };
    expect(() => applySnapshot(lateJoiner, snap)).toThrow(CollabProtocolError);
    expect(lateJoiner.doc.nodes).toHaveLength(0);
  });

  it('增量里带并发冲突 → unresolved conflicts 带出', () => {
    const peer = buildPeerState();
    const docId = peer.docId;
    // c_b 与 c_a 并发写标题
    const s = applyOp(peer, opEnv(header(docId, 'c_b', 5), { kind: 'set-doc-meta', patch: { title: 'B 的标题' } })).state;
    const lateJoiner = emptyJoiner();
    const req = buildSnapshotRequest({ docId, clientId: 'c_b', tabName: 'B', tabColor: '#f00', lamport: 1, requestVv: {} });
    const snap = buildSnapshotResponse({ docId, clientId: 'c_a', tabName: 'A', tabColor: '#0f0', lamport: 6, state: s, requestVv: req.requestVv });
    const res = applySnapshot(lateJoiner, snap);
    expect(res.conflicts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('墓碑与 opId 表压缩', () => {
  it('pruneTombstones：旧墓碑丢弃，新墓碑保留', () => {
    let s = freshState();
    const docId = s.docId;
    s = applyOp(s, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 2), { kind: 'delete-nodes', nodeIds: ['n1'] })).state;
    expect(s.nodeMeta['n1']!.tombstone).not.toBeNull();
    const pruned = pruneTombstones(s, 2); // watermark 含 lamport=2
    expect(pruned.nodeMeta['n1']).toBeUndefined();
    const kept = pruneTombstones(s, 1);
    expect(kept.nodeMeta['n1']!.tombstone).not.toBeNull();
  });

  it('pruneAppliedOps：只保留最近 N 个 opId/log', () => {
    let s = freshState();
    const docId = s.docId;
    for (let i = 1; i <= 5; i++) {
      s = applyOp(s, opEnv(header(docId, 'c_a', i), { kind: 'add-node', node: node(`n${i}`) })).state;
    }
    expect(s.appliedOpIds).toHaveLength(5);
    const p = pruneAppliedOps(s, 2);
    expect(p.appliedOpIds).toHaveLength(2);
    expect(p.log).toHaveLength(2);
  });

  it('compactCollabState 组合压缩', () => {
    let s = freshState();
    const docId = s.docId;
    s = applyOp(s, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 2), { kind: 'delete-nodes', nodeIds: ['n1'] })).state;
    const c = compactCollabState(s, { tombstoneWatermark: 2, keepAppliedOps: 1 });
    expect(c.nodeMeta['n1']).toBeUndefined();
    expect(c.appliedOpIds).toHaveLength(1);
  });
});
