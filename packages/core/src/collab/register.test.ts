import { describe, it, expect } from 'vitest';
import { applyOp } from './merge.js';
import { header, opEnv, freshState, node } from './test-helpers.js';
import type { CollabState } from './state.js';

function docIdOf(st: CollabState): string {
  return st.docId;
}

function makeStateWithNode(): { st: CollabState; docId: string } {
  let st = freshState();
  const docId = docIdOf(st);
  st = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
  return { st, docId };
}

describe('寄存器并集：tags / pageBreaks / points', () => {
  it('并发往 tags 加不同标签 → 双方并集（不互相覆盖）', () => {
    const { st, docId } = makeStateWithNode();
    // c_a 加 tag "red"
    let s = applyOp(st, opEnv(header(docId, 'c_a', 2), {
      kind: 'reg-add', entity: 'node', entityId: 'n1', field: 'tags', items: ['red'],
    })).state;
    // c_b 并发加 tag "blue"
    s = applyOp(s, opEnv(header(docId, 'c_b', 3), {
      kind: 'reg-add', entity: 'node', entityId: 'n1', field: 'tags', items: ['blue'],
    })).state;
    const tags = s.doc.nodes.find((n) => n.id === 'n1')!.tags;
    expect(tags).toHaveLength(2);
    expect(tags).toContain('red');
    expect(tags).toContain('blue');
  });

  it('一方加一方删：删除生效（墓碑压住旧 add，不复活）', () => {
    const { st, docId } = makeStateWithNode();
    // c_a 先把 red 加上（lamport 2）
    let s = applyOp(st, opEnv(header(docId, 'c_a', 2), {
      kind: 'reg-add', entity: 'node', entityId: 'n1', field: 'tags', items: ['red'],
    })).state;
    // c_b 并发删除 red（lamport 3，晚于 add）
    s = applyOp(s, opEnv(header(docId, 'c_b', 3), {
      kind: 'reg-remove', entity: 'node', entityId: 'n1', field: 'tags', keys: ['t:red'],
    })).state;
    expect(s.doc.nodes.find((n) => n.id === 'n1')!.tags).toEqual([]);

    // 迟到的旧 add（lamport 2 < 墓碑 lamport 3）→ 不复活
    const lateAdd = applyOp(s, opEnv(header(docId, 'c_a', 2), {
      kind: 'reg-add', entity: 'node', entityId: 'n1', field: 'tags', items: ['red'],
    }));
    expect(lateAdd.state.doc.nodes.find((n) => n.id === 'n1')!.tags).toEqual([]);
  });

  it('删除后更高 lamport 重新 add → 复活（LWW-remove）', () => {
    const { st, docId } = makeStateWithNode();
    let s = applyOp(st, opEnv(header(docId, 'c_a', 2), {
      kind: 'reg-add', entity: 'node', entityId: 'n1', field: 'tags', items: ['red'],
    })).state;
    // c_b 删 red（lamport 3）
    s = applyOp(s, opEnv(header(docId, 'c_b', 3), {
      kind: 'reg-remove', entity: 'node', entityId: 'n1', field: 'tags', keys: ['t:red'],
    })).state;
    expect(s.doc.nodes.find((n) => n.id === 'n1')!.tags).toEqual([]);
    // c_a 更高 lamport 重新加 red（4 > 3）→ 复活
    s = applyOp(s, opEnv(header(docId, 'c_a', 4), {
      kind: 'reg-add', entity: 'node', entityId: 'n1', field: 'tags', items: ['red'],
    })).state;
    expect(s.doc.nodes.find((n) => n.id === 'n1')!.tags).toEqual(['red']);
  });

  it('并发加不同分页点 → 并集', () => {
    let st = freshState();
    const docId = docIdOf(st);
    st = applyOp(st, opEnv(header(docId, 'c_a', 1), {
      kind: 'reg-add', entity: 'page', entityId: 'page', field: 'pageBreaks',
      items: [{ at: 500, id: 'pb1', x: 0, y: 500 }],
    })).state;
    st = applyOp(st, opEnv(header(docId, 'c_b', 2), {
      kind: 'reg-add', entity: 'page', entityId: 'page', field: 'pageBreaks',
      items: [{ at: 900, id: 'pb2', x: 0, y: 900 }],
    })).state;
    const breaks = st.doc.page.pageBreaks as { id: string }[];
    expect(breaks).toHaveLength(2);
    expect(breaks.map((b) => b.id).sort()).toEqual(['pb1', 'pb2']);

    // 删除其中一个 → 真的删掉
    st = applyOp(st, opEnv(header(docId, 'c_a', 3), {
      kind: 'reg-remove', entity: 'page', entityId: 'page', field: 'pageBreaks', keys: ['b:pb1'],
    })).state;
    const after = st.doc.page.pageBreaks as { id: string }[];
    expect(after.map((b) => b.id)).toEqual(['pb2']);
  });

  it('同一 opId 重复 → duplicate 不重复追加', () => {
    const { st, docId } = makeStateWithNode();
    const env = opEnv(header(docId, 'c_a', 2), {
      kind: 'reg-add', entity: 'node', entityId: 'n1', field: 'tags', items: ['red'],
    }, 'op_reg_1');
    const r1 = applyOp(st, env);
    expect(r1.outcome).toBe('applied');
    const r2 = applyOp(r1.state, env);
    expect(r2.outcome).toBe('duplicate');
    expect(r2.state.doc.nodes.find((n) => n.id === 'n1')!.tags).toEqual(['red']);
  });
});
