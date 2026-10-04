import { describe, it, expect } from 'vitest';
import { buildMainTree } from '@drawpaper/core';
import type { BlockNode, Edge } from '@drawpaper/core';
import {
  canReparent,
  resolveReparentTarget,
  positionFromPointerRatio,
  isInSubtree,
} from './outline-dnd';

function makeNodes(): BlockNode[] {
  const base = { x: 0, y: 0, width: 100, height: 40, content: { format: 'tiptap-json' as const, data: {} }, parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {} };
  return [
    { id: 'a', type: 'heading', ...base },
    { id: 'b', type: 'text', ...base },
    { id: 'c', type: 'text', ...base },
    { id: 'd', type: 'text', ...base },
    { id: 'e', type: 'text', ...base },
  ];
}

// a -> b -> c ; a -> d ; e 根级游离
const EDGES: Edge[] = [
  { id: 'e1', source: 'a', target: 'b', sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#000' } },
  { id: 'e2', source: 'b', target: 'c', sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#000' } },
  { id: 'e3', source: 'a', target: 'd', sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#000' } },
];

function tree() {
  return buildMainTree(makeNodes(), EDGES);
}

describe('outline-dnd', () => {
  it('isInSubtree：子树含自身与后代', () => {
    const t = tree();
    expect(isInSubtree(t, 'a', 'a')).toBe(true);
    expect(isInSubtree(t, 'a', 'c')).toBe(true);
    expect(isInSubtree(t, 'a', 'e')).toBe(false);
  });

  it('canReparent：拖到自己后代上非法', () => {
    const t = tree();
    expect(canReparent(t, 'a', 'b', 'child')).toBe(false);
    expect(canReparent(t, 'a', 'c', 'before')).toBe(false);
    expect(canReparent(t, 'b', 'c', 'child')).toBe(false);
  });

  it('canReparent：同级/跨分支移动合法', () => {
    const t = tree();
    expect(canReparent(t, 'd', 'b', 'before')).toBe(true);
    expect(canReparent(t, 'e', 'a', 'child')).toBe(true);
    expect(canReparent(t, 'c', 'e', 'child')).toBe(true);
  });

  it('resolveReparentTarget：child 落点 = 目标的最后一个子', () => {
    const t = tree();
    const r = resolveReparentTarget(t, 'e', 'a', 'child');
    expect(r).toEqual({ newParentId: 'a', index: 2 }); // a 的现有子：b, d
  });

  it('resolveReparentTarget：before/after = 目标父下的兄弟位', () => {
    const t = tree();
    // a 的子序列 [b, d]；把 e 放到 b 之前
    expect(resolveReparentTarget(t, 'e', 'b', 'before')).toEqual({ newParentId: 'a', index: 0 });
    // 放到 d 之后
    expect(resolveReparentTarget(t, 'e', 'd', 'after')).toEqual({ newParentId: 'a', index: 2 });
  });

  it('resolveReparentTarget：拖自己/拖后代 → null', () => {
    const t = tree();
    expect(resolveReparentTarget(t, 'a', 'a', 'child')).toBeNull();
    expect(resolveReparentTarget(t, 'a', 'c', 'after')).toBeNull();
    expect(resolveReparentTarget(t, 'x', 'missing', 'child')).toBeNull();
  });

  it('resolveReparentTarget：根级兄弟（目标无父）→ newParentId null', () => {
    const t = tree();
    // e 是根级；把 d 放到 e 之后 → 挂到根级 null
    const r = resolveReparentTarget(t, 'd', 'e', 'after');
    expect(r?.newParentId).toBeNull();
  });

  it('positionFromPointerRatio：上中下三带', () => {
    expect(positionFromPointerRatio(0.1)).toBe('before');
    expect(positionFromPointerRatio(0.5)).toBe('child');
    expect(positionFromPointerRatio(0.9)).toBe('after');
  });
});
