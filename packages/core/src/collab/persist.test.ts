import { describe, it, expect } from 'vitest';
import { applyOp } from './merge.js';
import { serializeCollabMeta, hydrateCollabMeta } from './persist.js';
import { header, opEnv, freshState, node } from './test-helpers.js';
import { createLamportClock } from './clock.js';

describe('CollabState 元数据持久化（reload 恢复）', () => {
  it('serialize → hydrate 往返恢复 vv / 字段时钟 / 寄存器墓碑 / 时钟水位', () => {
    let st = freshState();
    const docId = st.docId;
    st = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
    st = applyOp(st, opEnv(header(docId, 'c_a', 5), {
      kind: 'update-node', nodeId: 'n1', patch: { x: 100 },
    })).state;
    st = applyOp(st, opEnv(header(docId, 'c_b', 7), {
      kind: 'reg-add', entity: 'node', entityId: 'n1', field: 'tags', items: ['red'],
    })).state;

    const persisted = serializeCollabMeta(st, 42);
    expect(persisted.clockValue).toBe(42);

    // 模拟 reload：从落盘 doc 重建。
    const docOnDisk = st.doc;
    const restored = hydrateCollabMeta(docOnDisk, persisted);
    expect(restored).not.toBeNull();
    expect(restored!.clockValue).toBe(42);
    expect(restored!.state.vv['c_a']).toBe(5);
    expect(restored!.state.vv['c_b']).toBe(7);
    // n1 的 x 字段时钟恢复为 5（不再是 lamport=0 播种）
    expect(restored!.state.nodeMeta['n1']!.fields['x']!.lamport).toBe(5);
    // 寄存器 adds 恢复
    expect(restored!.state.regMeta['node:n1:tags']!.adds['t:red']).toBeDefined();
  });

  it('旧文档无元数据 / 损坏 → 返回 null，回退 lamport=0 播种', () => {
    const st = freshState();
    expect(hydrateCollabMeta(st.doc, null)).toBeNull();
    expect(hydrateCollabMeta(st.doc, { v: 999, docId: st.docId })).toBeNull();
    expect(hydrateCollabMeta(st.doc, 'garbage')).toBeNull();
  });

  it('reload 后继续编辑：旧 op 不会因字段时钟回退而覆盖既有值', () => {
    // 标签 A：建块并把 x 写到 lamport 5。
    let stA = freshState();
    const docId = stA.docId;
    stA = applyOp(stA, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
    stA = applyOp(stA, opEnv(header(docId, 'c_a', 5), {
      kind: 'update-node', nodeId: 'n1', patch: { x: 100 },
    })).state;

    // 持久化 + reload（字段时钟应恢复为 5，而非回退到 0）。
    const persisted = serializeCollabMeta(stA, 5);
    const restored = hydrateCollabMeta(stA.doc, persisted)!;

    // reload 后一条迟到的旧写（c_b lamport 3 < 5）到达：必须输掉，不能把 x 覆盖回旧值。
    const late = applyOp(restored.state, opEnv(header(docId, 'c_b', 3), {
      kind: 'update-node', nodeId: 'n1', patch: { x: 1 },
    }));
    expect(late.state.doc.nodes.find((n) => n.id === 'n1')!.x).toBe(100);

    // reload 后本端继续写（时钟水位 5 → tick 到 6）：本端同 clientId 永远胜。
    const clock = createLamportClock(restored.clockValue);
    const after = applyOp(restored.state, opEnv(header(docId, 'c_a', clock.tick()), {
      kind: 'update-node', nodeId: 'n1', patch: { x: 200 },
    }));
    expect(after.state.doc.nodes.find((n) => n.id === 'n1')!.x).toBe(200);
    expect(after.state.nodeMeta['n1']!.fields['x']!.lamport).toBe(6);
  });
});
