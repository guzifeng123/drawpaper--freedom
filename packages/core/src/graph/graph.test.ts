import { describe, it, expect } from 'vitest';
import {
  buildMainTree,
  enumerateSubtree,
  connectedComponents,
  findOrphans,
  detectConflicts,
  analyzeGraph,
  suggestMainTreeDecision,
} from './graph.js';
import type { BlockNode, Edge } from '../model/index.js';

function node(id: string): BlockNode {
  return {
    id,
    type: 'text',
    x: 0,
    y: 0,
    width: 260,
    height: 80,
    content: { format: 'tiptap-json', data: {} },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
  };
}

function edge(id: string, source: string, target: string): Edge {
  return {
    id,
    source,
    target,
    sourceHandle: 'right',
    targetHandle: 'left',
    label: '',
    directed: true,
    style: { color: '#94A3B8' },
  };
}

describe('buildMainTree', () => {
  it('builds a forest with multiple roots and correct depth', () => {
    // chain1: a -> b -> c ; chain2: r -> s
    const nodes = [node('a'), node('b'), node('c'), node('r'), node('s')];
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'r', 's')];
    const tree = buildMainTree(nodes, edges);
    expect(tree.roots.sort()).toEqual(['a', 'r']);
    expect(tree.nodes['a']!.depth).toBe(0);
    expect(tree.nodes['b']!.depth).toBe(1);
    expect(tree.nodes['c']!.depth).toBe(2);
    expect(tree.nodes['r']!.depth).toBe(0);
    expect(tree.nodes['s']!.depth).toBe(1);
    expect(tree.nodes['b']!.parentId).toBe('a');
    expect(tree.nodes['a']!.children).toEqual(['b']);
  });

  it('multi-parent: first incoming edge wins (stable)', () => {
    const nodes = [node('p1'), node('p2'), node('c')];
    // edges order: e1 (p1->c) first, e2 (p2->c) second
    const edges = [edge('e1', 'p1', 'c'), edge('e2', 'p2', 'c')];
    const tree = buildMainTree(nodes, edges);
    expect(tree.nodes['c']!.parentId).toBe('p1');
    expect(tree.nodes['p1']!.children).toEqual(['c']);
  });

  it('breaks a 2-cycle deterministically: last edge dropped', () => {
    const nodes = [node('a'), node('b')];
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')];
    const tree = buildMainTree(nodes, edges);
    // e1 wins, e2 dropped -> root a, b child of a
    expect(tree.roots).toEqual(['a']);
    expect(tree.nodes['b']!.parentId).toBe('a');
    expect(tree.nodes['a']!.parentId).toBeNull();
    expect(tree.nodes['b']!.depth).toBe(1);
  });
});

describe('enumerateSubtree', () => {
  it('returns self + all descendants', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'a', 'c'), edge('e3', 'b', 'd')];
    const tree = buildMainTree(nodes, edges);
    const sub = enumerateSubtree(tree, 'a').sort();
    expect(sub).toEqual(['a', 'b', 'c', 'd']);
    expect(enumerateSubtree(tree, 'b').sort()).toEqual(['b', 'd']);
    expect(enumerateSubtree(tree, 'c')).toEqual(['c']);
  });
});

describe('connectedComponents', () => {
  it('groups connected nodes; orphan forms singleton component', () => {
    const nodes = [node('a'), node('b'), node('c'), node('alone')];
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')];
    const comps = connectedComponents(nodes, edges).map((c) => c.sort());
    expect(comps).toHaveLength(2);
    expect(comps).toContainEqual(['a', 'b', 'c']);
    expect(comps).toContainEqual(['alone']);
  });
});

describe('findOrphans', () => {
  it('returns nodes not referenced by any edge', () => {
    const nodes = [node('a'), node('b'), node('alone')];
    const edges = [edge('e1', 'a', 'b')];
    expect(findOrphans(nodes, edges)).toEqual(['alone']);
  });
});

describe('detectConflicts', () => {
  it('reports multi-parent with all incoming edges', () => {
    const nodes = [node('p1'), node('p2'), node('c')];
    const edges = [edge('e1', 'p1', 'c'), edge('e2', 'p2', 'c')];
    const { multiParents } = detectConflicts(nodes, edges);
    expect(multiParents).toHaveLength(1);
    expect(multiParents[0]).toMatchObject({
      nodeId: 'c',
      parentEdgeIds: ['e1', 'e2'],
      parentIds: ['p1', 'p2'],
    });
  });

  it('reports a 3-node cycle with edge ids', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'a')];
    const { cycles } = detectConflicts(nodes, edges);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.edgeIds.sort()).toEqual(['e1', 'e2', 'e3']);
  });
});

describe('analyzeGraph + suggestMainTreeDecision', () => {
  it('aggregates tree/multiParents/cycles/dangling/orphans', () => {
    const nodes = [node('p1'), node('p2'), node('c'), node('a'), node('b'), node('alone')];
    const edges = [
      edge('e1', 'p1', 'c'),
      edge('e2', 'p2', 'c'), // multi-parent on c
      edge('e3', 'a', 'b'),
      edge('e4', 'b', 'a'), // 2-cycle a<->b
      edge('e5', 'x', 'c'), // dangling (x missing)
    ];
    const analysis = analyzeGraph(nodes, edges);
    expect(analysis.multiParents).toHaveLength(1);
    expect(analysis.cycles).toHaveLength(1);
    expect(analysis.danglingEdges).toContain('e5');
    expect(analysis.orphanNodes).toEqual(['alone']);

    const decision = suggestMainTreeDecision(analysis);
    // multi-parent: keep e1, drop e2
    expect(decision.keepParentEdgeIds).toEqual(['e1']);
    expect(decision.dropEdgeIds).toEqual(['e2']);
    // cycle: break last edge of the cycle. cycle edges = [e3,e4] (order discovered); last = e4
    expect(decision.breakCycleEdgeIds).toEqual(['e4']);
  });
});
