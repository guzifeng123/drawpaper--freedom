import { describe, it, expect } from 'vitest';
import {
  parseEnvelope,
  serializeEnvelope,
  CollabProtocolError,
  COLLAB_PROTOCOL_VERSION,
  isOpEnvelope,
} from './envelope.js';
import { header, opEnv, makeDoc, freshState } from './test-helpers.js';
import { applyOp } from './merge.js';

describe('信封 serialize/parse', () => {
  it('op 信封往返一致', () => {
    const h = header('doc_x', 'c_a', 3);
    const e = opEnv(h, { kind: 'set-doc-meta', patch: { title: '新标题' } }, 'op_1');
    const text = serializeEnvelope(e);
    const back = parseEnvelope(text);
    expect(back).toEqual(e);
    expect(isOpEnvelope(back)).toBe(true);
  });

  it('对象形态（structuredClone）也能解析', () => {
    const h = header('doc_x', 'c_a', 3);
    const e = opEnv(h, { kind: 'add-node', node: {
      id: 'n1', type: 'text', x: 1, y: 2, width: 260, height: 80,
      content: { format: 'tiptap-json', data: {} },
      parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {},
    } });
    const back = parseEnvelope(JSON.parse(JSON.stringify(e)));
    expect(back.kind).toBe('op');
  });

  it('坏 JSON 抛 bad-json', () => {
    try {
      parseEnvelope('{oops');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CollabProtocolError);
      expect((e as CollabProtocolError).code).toBe('bad-json');
    }
  });

  it('协议版本不符抛 version-mismatch', () => {
    const bad = { v: 99, kind: 'op', docId: 'd', clientId: 'c', lamport: 1 };
    try {
      parseEnvelope(bad);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CollabProtocolError);
      expect((e as CollabProtocolError).code).toBe('version-mismatch');
    }
  });

  it('形状不对抛 bad-envelope，且不影响状态', () => {
    const before = freshState(makeDoc());
    try {
      parseEnvelope({ v: COLLAB_PROTOCOL_VERSION, kind: 'op', docId: 'd', clientId: 'c', lamport: 1 });
      expect.unreachable();
    } catch (e) {
      expect((e as CollabProtocolError).code).toBe('bad-envelope');
      expect((e as CollabProtocolError).issues.length).toBeGreaterThan(0);
    }
    // 状态没被污染
    expect(before.doc.nodes).toHaveLength(0);
  });

  it('未知 kind 被拒绝', () => {
    expect(() =>
      parseEnvelope({ v: 1, kind: 'teleport', docId: 'd', clientId: 'c', lamport: 1 }),
    ).toThrow(CollabProtocolError);
  });

  it('presence 信封可解析', () => {
    const env = {
      v: 1, kind: 'presence', docId: 'd', clientId: 'c', tabName: 't', tabColor: '#fff', lamport: 2,
      presence: { docId: 'd', selection: ['n1'], hoverNodeId: null, blockRect: null, heartbeatSeq: 3 },
    };
    const back = parseEnvelope(env);
    expect(back.kind).toBe('presence');
  });

  it('op 到达错误 docId 抛错（路由 bug，状态不变）', () => {
    const st = freshState(makeDoc());
    const h = header('other-doc', 'c_a', 1);
    const e = opEnv(h, { kind: 'set-doc-meta', patch: { title: 'x' } });
    expect(() => applyOp(st, e)).toThrow(/docId 不匹配/);
  });
});
