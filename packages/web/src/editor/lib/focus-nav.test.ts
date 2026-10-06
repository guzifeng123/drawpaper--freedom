import { describe, it, expect } from 'vitest';
import type { BlockNode, Edge } from '@drawpaper/core';
import {
  findChildIds,
  findParentId,
  findSiblingIds,
  navigateFocus,
} from './focus-nav';

/** 构造一个最小节点（导航只用 id/x/y/width/height）。 */
function node(id: string, x = 0, y = 0): BlockNode {
  return {
    id,
    type: 'text',
    x,
    y,
    width: 200,
    height: 60,
    content: { format: 'tiptap-json', data: {} },
    style: {},
  } as BlockNode;
}

function edge(source: string, target: string): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    sourceHandle: 'right',
    targetHandle: 'left',
    style: {},
  } as Edge;
}

/** 树：root(0,0) → a(0,100) / b(200,100)，a → c(0,200)。 */
const nodes = [node('root', 0, 0), node('a', 0, 100), node('b', 200, 100), node('c', 0, 200)];
const edges = [edge('root', 'a'), edge('root', 'b'), edge('a', 'c')];
const doc = { nodes, edges };

describe('focus-nav', () => {
  it('findParentId / findChildIds', () => {
    expect(findParentId(doc, 'a')).toBe('root');
    expect(findParentId(doc, 'root')).toBeNull();
    expect(findChildIds(doc, 'root')).toEqual(['a', 'b']); // y 升序
    expect(findChildIds(doc, 'a')).toEqual(['c']);
  });

  it('findSiblingIds sorts by y and includes self', () => {
    expect(findSiblingIds(doc, 'a')).toEqual(['a', 'b']);
    expect(findSiblingIds(doc, 'c')).toEqual(['c']); // a 唯一子
  });

  it('Alt+Right = first child', () => {
    expect(navigateFocus(doc, 'root', 'firstChild')).toBe('a');
    expect(navigateFocus(doc, 'a', 'firstChild')).toBe('c');
    expect(navigateFocus(doc, 'c', 'firstChild')).toBeNull(); // 叶子
  });

  it('Alt+Left = parent', () => {
    expect(navigateFocus(doc, 'c', 'parent')).toBe('a');
    expect(navigateFocus(doc, 'a', 'parent')).toBe('root');
    expect(navigateFocus(doc, 'root', 'parent')).toBeNull(); // 根
  });

  it('Alt+Down = next sibling (clamped)', () => {
    expect(navigateFocus(doc, 'a', 'nextSibling')).toBe('b');
    expect(navigateFocus(doc, 'b', 'nextSibling')).toBeNull();
  });

  it('Alt+Up = prev sibling (clamped)', () => {
    expect(navigateFocus(doc, 'b', 'prevSibling')).toBe('a');
    expect(navigateFocus(doc, 'a', 'prevSibling')).toBeNull();
  });

  it('no selection: Alt+Down picks topmost, Alt+Up picks bottommost', () => {
    expect(navigateFocus(doc, null, 'nextSibling')).toBe('root');
    expect(navigateFocus(doc, null, 'prevSibling')).toBe('c');
  });
});
