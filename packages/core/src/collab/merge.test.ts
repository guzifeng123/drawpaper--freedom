import { describe, it, expect } from 'vitest';
import { applyOp } from './merge.js';
import type { ApplyResult } from './merge.js';
import { describeConflict, summarizeConflicts } from './conflicts.js';
import { header, opEnv, freshState, node, edge } from './test-helpers.js';
import type { CollabState } from './state.js';

function docIdOf(st: CollabState): string {
  return st.docId;
}

describe('幂等：乱序 / 重复 / 延迟', () => {
  it('同一 opId 重复到达 → duplicate，状态不变', () => {
    const st = freshState();
    const h = header(docIdOf(st), 'c_a', 1);
    const e = opEnv(h, { kind: 'add-node', node: node('n1') }, 'op_same');
    const r1 = applyOp(st, e);
    expect(r1.outcome).toBe('applied');
    expect(r1.state.doc.nodes).toHaveLength(1);
    const r2 = applyOp(r1.state, e);
    expect(r2.outcome).toBe('duplicate');
    expect(r2.state).toBe(r1.state); // 引用相同，未拷贝
  });

  it('乱序收敛：先应用高 lamport 再补低 lamport，最终值由时间戳决定（与到达顺序无关）', () => {
    const st = freshState();
    const docId = docIdOf(st);
    const add = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') }));

    // c_a lamport 5 写 x=100 先到；c_b lamport 3 写 x=200 后到（迟到）
    const late = applyOp(add.state, opEnv(header(docId, 'c_b', 3), {
      kind: 'update-node', nodeId: 'n1', patch: { x: 200 },
    }));
    const early = applyOp(late.state, opEnv(header(docId, 'c_a', 5), {
      kind: 'update-node', nodeId: 'n1', patch: { x: 100 },
    }));
    expect(early.state.doc.nodes.find((n) => n.id === 'n1')!.x).toBe(100);

    // 反序再来一遍：结果一致（收敛）
    const st2 = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') }));
    const rA = applyOp(st2.state, opEnv(header(docId, 'c_a', 5), { kind: 'update-node', nodeId: 'n1', patch: { x: 100 } }));
    const rB = applyOp(rA.state, opEnv(header(docId, 'c_b', 3), { kind: 'update-node', nodeId: 'n1', patch: { x: 200 } }));
    expect(rB.state.doc.nodes.find((n) => n.id === 'n1')!.x).toBe(100);
  });

  it('不同字段并发修改双方都保留（字段级 LWW 不串扰）', () => {
    const st = freshState();
    const docId = docIdOf(st);
    let s = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 5), { kind: 'update-node', nodeId: 'n1', patch: { x: 100 } })).state;
    s = applyOp(s, opEnv(header(docId, 'c_b', 6), { kind: 'update-node', nodeId: 'n1', patch: { y: 200 } })).state;
    const n1 = s.doc.nodes.find((n) => n.id === 'n1')!;
    expect(n1.x).toBe(100);
    expect(n1.y).toBe(200);
  });
});

describe('字段级 LWW 各分支', () => {
  it('同字段并发：lamport 大者胜', () => {
    const st = freshState();
    const docId = docIdOf(st);
    const s = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
    const r1 = applyOp(s, opEnv(header(docId, 'c_a', 5), { kind: 'update-node', nodeId: 'n1', patch: { width: 260 } }));
    const r2 = applyOp(r1.state, opEnv(header(docId, 'c_b', 9), { kind: 'update-node', nodeId: 'n1', patch: { width: 400 } }));
    expect(r2.state.doc.nodes.find((n) => n.id === 'n1')!.width).toBe(400);
    expect(r2.conflicts).toHaveLength(1);
    expect(r2.conflicts[0]!.field).toBe('width');
  });

  it('同 Lamport 同帧并发：clientId 字典序小者胜（两种到达顺序收敛）', () => {
    for (const order of [['c_a', 'c_b'], ['c_b', 'c_a']] as const) {
      const st = freshState();
      const docId = docIdOf(st);
      let s = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
      const first = order[0];
      const second = order[1];
      s = applyOp(s, opEnv(header(docId, first, 5), { kind: 'update-node', nodeId: 'n1', patch: { height: first === 'c_a' ? 111 : 222 } })).state;
      s = applyOp(s, opEnv(header(docId, second, 5), { kind: 'update-node', nodeId: 'n1', patch: { height: second === 'c_a' ? 111 : 222 } })).state;
      expect(s.doc.nodes.find((n) => n.id === 'n1')!.height).toBe(111); // c_a 胜
    }
  });

  it('同 clientId 的连续写直接盖过，不记冲突', () => {
    const st = freshState();
    const docId = docIdOf(st);
    const s = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
    const r1 = applyOp(s, opEnv(header(docId, 'c_a', 5), { kind: 'update-node', nodeId: 'n1', patch: { collapsed: false } }));
    const r2 = applyOp(r1.state, opEnv(header(docId, 'c_a', 8), { kind: 'update-node', nodeId: 'n1', patch: { collapsed: true } }));
    expect(r2.state.doc.nodes.find((n) => n.id === 'n1')!.collapsed).toBe(true);
    expect(r2.conflicts).toHaveLength(0);
  });

  it('两边写相同值 → 收敛，不记冲突', () => {
    const st = freshState();
    const docId = docIdOf(st);
    let s = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 5), { kind: 'update-node', nodeId: 'n1', patch: { pinned: true } })).state;
    const r = applyOp(s, opEnv(header(docId, 'c_b', 6), { kind: 'update-node', nodeId: 'n1', patch: { pinned: true } }));
    expect(r.conflicts).toHaveLength(0);
  });
});

describe('删除优先 + 墓碑', () => {
  it('delete-nodes 级联删入射出边并打墓碑', () => {
    const st = freshState();
    const docId = docIdOf(st);
    let s = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 2), { kind: 'add-node', node: node('n2') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 3), { kind: 'add-edge', edge: edge('e1', 'n1', 'n2') })).state;
    expect(s.doc.edges).toHaveLength(1);
    const r = applyOp(s, opEnv(header(docId, 'c_a', 4), { kind: 'delete-nodes', nodeIds: ['n1'] }));
    expect(r.state.doc.nodes.map((n) => n.id)).toEqual(['n2']);
    expect(r.state.doc.edges).toHaveLength(0);
    expect(r.state.nodeMeta['n1']!.tombstone).toEqual({ lamport: 4, clientId: 'c_a' });
    expect(r.state.edgeMeta['e1']!.tombstone).not.toBeNull();
  });

  it('晚到的旧 update 不复活被删节点', () => {
    const st = freshState();
    const docId = docIdOf(st);
    let s = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 5), { kind: 'delete-nodes', nodeIds: ['n1'] })).state;
    // 迟到的 update（lamport 3 < 墓碑 5）
    const r = applyOp(s, opEnv(header(docId, 'c_b', 3), { kind: 'update-node', nodeId: 'n1', patch: { x: 999 } }));
    expect(r.outcome).toBe('suppressed-tombstone');
    expect(r.state.doc.nodes).toHaveLength(0);
  });

  it('晚到的重建（add-node，lamport 严格大于墓碑）可以复活', () => {
    const st = freshState();
    const docId = docIdOf(st);
    let s = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1', 0, 0) })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 5), { kind: 'delete-nodes', nodeIds: ['n1'] })).state;
    // 与墓碑同 lamport 的重建：删除优先，不复活
    const sameTs = applyOp(s, opEnv(header(docId, 'c_b', 5), { kind: 'add-node', node: node('n1', 50, 50) }));
    expect(sameTs.outcome).toBe('suppressed-tombstone');
    expect(sameTs.state.doc.nodes).toHaveLength(0);
    // 严格更大的 lamport：允许重建
    const revive = applyOp(sameTs.state, opEnv(header(docId, 'c_b', 6), { kind: 'add-node', node: node('n1', 50, 50) }));
    expect(revive.outcome).toBe('applied');
    expect(revive.state.doc.nodes).toHaveLength(1);
    expect(revive.state.doc.nodes[0]!.x).toBe(50);
  });

  it('delete-edge 墓碑后晚到 update-edge 被压制', () => {
    const st = freshState();
    const docId = docIdOf(st);
    let s = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 2), { kind: 'add-node', node: node('n2') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 3), { kind: 'add-edge', edge: edge('e1', 'n1', 'n2') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 4), { kind: 'delete-edge', edgeId: 'e1' })).state;
    const r = applyOp(s, opEnv(header(docId, 'c_b', 3), { kind: 'update-edge', edgeId: 'e1', patch: { label: 'late' } }));
    expect(r.outcome).toBe('suppressed-tombstone');
    expect(r.state.doc.edges).toHaveLength(0);
  });
});

describe('结构性冲突：并发 reparent 到不同父', () => {
  it('胜方生效、败方入 conflicts、摘要可读', () => {
    const st = freshState();
    const docId = docIdOf(st);
    let s = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 2), { kind: 'add-node', node: node('pA') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_b', 2), { kind: 'add-node', node: node('pB') })).state;

    // c_a lamport 5 挂到 pA；c_b lamport 5 挂到 pB（同帧并发）
    const r1 = applyOp(s, opEnv(header(docId, 'c_a', 5), { kind: 'update-node', nodeId: 'n1', patch: { parentId: 'pA' } }));
    const r2 = applyOp(r1.state, opEnv(header(docId, 'c_b', 5), { kind: 'update-node', nodeId: 'n1', patch: { parentId: 'pB' } }));

    // c_a clientId 小者胜 → parentId=pA
    expect(r2.state.doc.nodes.find((n) => n.id === 'n1')!.parentId).toBe('pA');
    expect(r2.conflicts).toHaveLength(1);
    const c = r2.conflicts[0]!;
    expect(c.kind).toBe('reparent');
    expect(c.field).toBe('parentId');
    expect(c.winner.clientId).toBe('c_a');
    expect(c.loser.clientId).toBe('c_b');

    const text = describeConflict(c, new Map([['c_a', '左屏'], ['c_b', '右屏']]));
    expect(text).toContain('左屏');
    expect(text).toContain('右屏');
    expect(text).toContain('不同父节点');
    const arr = summarizeConflicts([c]);
    expect(arr[0]).toContain('冲突');
  });

  it('不同字段并发 reparent 不算同一冲突', () => {
    const st = freshState();
    const docId = docIdOf(st);
    let s = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 5), { kind: 'update-node', nodeId: 'n1', patch: { parentId: null } })).state;
    const r = applyOp(s, opEnv(header(docId, 'c_b', 6), { kind: 'update-node', nodeId: 'n1', patch: { parentId: null } }));
    // 值相同（都 null）→ 收敛
    expect(r.conflicts).toHaveLength(0);
  });
});

describe('其余 op 类别', () => {
  it('set-doc-meta 标题 LWW + 冲突记录', () => {
    const st = freshState();
    const docId = docIdOf(st);
    const r1 = applyOp(st, opEnv(header(docId, 'c_a', 5), { kind: 'set-doc-meta', patch: { title: 'A 标题' } }));
    expect(r1.state.doc.title).toBe('A 标题');
    const r2 = applyOp(r1.state, opEnv(header(docId, 'c_b', 6), { kind: 'set-doc-meta', patch: { title: 'B 标题' } }));
    expect(r2.state.doc.title).toBe('B 标题');
    expect(r2.conflicts[0]!.entity).toBe('doc');
    // 旧标题回退不会复活
    const r3 = applyOp(r2.state, opEnv(header(docId, 'c_a', 4), { kind: 'set-doc-meta', patch: { title: 'A 标题' } }));
    expect(r3.state.doc.title).toBe('B 标题');
  });

  it('set-page 分页设置 LWW', () => {
    const st = freshState();
    const docId = docIdOf(st);
    const r1 = applyOp(st, opEnv(header(docId, 'c_a', 5), { kind: 'set-page', patch: { mode: 'tiles' } }));
    expect(r1.state.doc.page.mode).toBe('tiles');
    const r2 = applyOp(r1.state, opEnv(header(docId, 'c_b', 6), { kind: 'set-page', patch: { orientation: 'landscape' } }));
    expect(r2.state.doc.page.mode).toBe('tiles');
    expect(r2.state.doc.page.orientation).toBe('landscape');
  });

  it('move-nodes 批量落位', () => {
    const st = freshState();
    const docId = docIdOf(st);
    let s = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 2), { kind: 'add-node', node: node('n2') })).state;
    const r = applyOp(s, opEnv(header(docId, 'c_a', 3), {
      kind: 'move-nodes',
      positions: [{ nodeId: 'n1', x: 100, y: 200 }, { nodeId: 'n2', x: 300, y: 400 }],
    }));
    expect(r.state.doc.nodes.find((n) => n.id === 'n1')!).toMatchObject({ x: 100, y: 200 });
    expect(r.state.doc.nodes.find((n) => n.id === 'n2')!).toMatchObject({ x: 300, y: 400 });
  });

  it('update-edge：color 映射到 style.color，points 可清除', () => {
    const st = freshState();
    const docId = docIdOf(st);
    let s = applyOp(st, opEnv(header(docId, 'c_a', 1), { kind: 'add-node', node: node('n1') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 2), { kind: 'add-node', node: node('n2') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 3), { kind: 'add-edge', edge: edge('e1', 'n1', 'n2') })).state;
    s = applyOp(s, opEnv(header(docId, 'c_a', 4), { kind: 'update-edge', edgeId: 'e1', patch: { color: '#ff0000', points: [{ x: 1, y: 2 }] } })).state;
    expect(s.doc.edges.find((e) => e.id === 'e1')!.style.color).toBe('#ff0000');
    expect(s.doc.edges.find((e) => e.id === 'e1')!.points).toHaveLength(1);
    s = applyOp(s, opEnv(header(docId, 'c_a', 5), { kind: 'update-edge', edgeId: 'e1', patch: { points: null } })).state;
    expect(s.doc.edges.find((e) => e.id === 'e1')!.points).toBeUndefined();
  });

  it('未知节点的 update-node → no-op（doc 不变）但 opId 已登记', () => {
    const st = freshState();
    const docId = docIdOf(st);
    const r: ApplyResult = applyOp(st, opEnv(header(docId, 'c_a', 5), { kind: 'update-node', nodeId: 'ghost', patch: { x: 1 } }));
    expect(r.outcome).toBe('no-op');
    expect(r.state.appliedOpIds).toHaveLength(1);
  });
});
