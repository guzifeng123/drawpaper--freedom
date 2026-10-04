import { describe, it, expect } from 'vitest';
import { createMockEditorApi, createEmptyDoc } from './mock-editor-api';

describe('mock EditorApi', () => {
  it('addNode 返回 id 并进入选择', () => {
    const api = createMockEditorApi();
    const id = api.addNode('text', 10, 20);
    expect(id).toBeTruthy();
    const s = api.getState();
    expect(s.doc.nodes).toHaveLength(1);
    expect(s.selection.has(id)).toBe(true);
  });

  it('自环 addEdge 被忽略', () => {
    const api = createMockEditorApi();
    const a = api.addNode('text', 0, 0);
    api.addEdge(a, a);
    expect(api.getState().doc.edges).toHaveLength(0);
  });

  it('多父：第二父边挂起冲突', () => {
    const api = createMockEditorApi();
    const p1 = api.addNode('text', 0, 0);
    const p2 = api.addNode('text', 100, 0);
    const c = api.addNode('text', 200, 100);
    api.addEdge(p1, c);
    expect(api.getState().pendingConflicts).toBeNull();
    api.addEdge(p2, c);
    const s = api.getState();
    expect(s.pendingConflicts?.multiParents).toHaveLength(1);
    expect(s.pendingConflicts?.multiParents[0]?.nodeId).toBe(c);
  });

  it('成环：A→B→C 再加 C→A 挂起环冲突', () => {
    const api = createMockEditorApi();
    const a = api.addNode('text', 0, 0);
    const b = api.addNode('text', 100, 0);
    const c = api.addNode('text', 200, 0);
    api.addEdge(a, b);
    api.addEdge(b, c);
    api.addEdge(c, a);
    const s = api.getState();
    expect(s.pendingConflicts?.cycles.length).toBeGreaterThan(0);
  });

  it('resolveConflicts 按主父裁决删边', () => {
    const api = createMockEditorApi();
    const p1 = api.addNode('text', 0, 0);
    const p2 = api.addNode('text', 100, 0);
    const c = api.addNode('text', 200, 100);
    api.addEdge(p1, c);
    api.addEdge(p2, c);
    const pending = api.getState().pendingConflicts!;
    const keep = pending.multiParents[0]!.parentEdgeIds[1]!;
    api.resolveConflicts({ choosePrimaryParent: { [c]: keep }, breakEdgeIds: [] });
    const s = api.getState();
    expect(s.pendingConflicts).toBeNull();
    expect(s.doc.edges).toHaveLength(1);
    expect(s.doc.edges[0]?.id).toBe(keep);
  });

  it('undo/redo', () => {
    const api = createMockEditorApi();
    const n0 = api.getState().doc.nodes.length;
    api.addNode('text', 0, 0);
    expect(api.getState().doc.nodes.length).toBe(n0 + 1);
    api.undo();
    expect(api.getState().doc.nodes.length).toBe(n0);
    api.redo();
    expect(api.getState().doc.nodes.length).toBe(n0 + 1);
  });

  it('toggleTodo 翻转 checked', () => {
    const api = createMockEditorApi();
    const id = api.addNode('todo', 0, 0);
    api.toggleTodo(id);
    expect(api.getState().doc.nodes.find((n) => n.id === id)?.todo?.checked).toBe(true);
  });

  it('tabAddChild 建子块并连边', () => {
    const api = createMockEditorApi();
    const p = api.addNode('text', 0, 0);
    api.setSelection([p]);
    api.tabAddChild();
    const s = api.getState();
    expect(s.doc.nodes).toHaveLength(2);
    expect(s.doc.edges[0]?.source).toBe(p);
    expect(s.selection.size).toBe(1);
  });

  it('空文档工厂', () => {
    const doc = createEmptyDoc();
    expect(doc.format).toBe('knowledge-block-notes');
    expect(doc.nodes).toEqual([]);
  });

  it('P1：reverseEdge 交换两端与句柄位', () => {
    const api = createMockEditorApi();
    const a = api.addNode('text', 0, 0);
    const b = api.addNode('text', 100, 0);
    api.addEdge(a, b);
    const edgeId = api.getState().doc.edges[0]!.id;
    api.reverseEdge?.(edgeId);
    const e = api.getState().doc.edges[0]!;
    expect(e.source).toBe(b);
    expect(e.target).toBe(a);
    expect(e.sourceHandle).toBe('left');
    expect(e.targetHandle).toBe('right');
  });

  it('P1：setFocusNode / setTagFilter 进入快照', () => {
    const api = createMockEditorApi();
    api.setFocusNode?.('n_x');
    expect(api.getState().focusNodeId).toBe('n_x');
    api.setTagFilter?.({ mode: 'all', tagIds: ['t1'] });
    expect(api.getState().tagFilter).toEqual({ mode: 'all', tagIds: ['t1'] });
  });

  it('P1：putImageAsset 返回引用 id', async () => {
    const api = createMockEditorApi();
    const r = await api.putImageAsset?.(new File(['x'], 'a.pdf', { type: 'application/pdf' }));
    expect(r?.assetRef).toBeTruthy();
    expect(r?.name).toBe('a.pdf');
  });

  it('P1：新块型默认尺寸取 editor 表（非 core 回退 260x80）', () => {
    const api = createMockEditorApi();
    const id = api.addNode('code', 0, 0);
    const n = api.getState().doc.nodes.find((x) => x.id === id)!;
    expect(n.width).toBe(320);
    expect(n.height).toBe(130);
  });
});
