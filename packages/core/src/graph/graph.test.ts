import { describe, it, expect } from 'vitest';
import {
  buildMainTree,
  enumerateSubtree,
  connectedComponents,
  findOrphans,
  detectConflicts,
  analyzeGraph,
  suggestMainTreeDecision,
  getAncestorChain,
  getDescendantSet,
  getRelatedChain,
  getFocusViewSet,
  buildChildCountMap,
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

/**
 * 手造多分支夹具：
 *        root
 *       /    \
 *      a      b
 *     / \      \
 *    c   d      e
 *   /
 *  f
 */
function multiBranch(): { nodes: BlockNode[]; edges: Edge[]; tree: ReturnType<typeof buildMainTree> } {
  const ids = ['root', 'a', 'b', 'c', 'd', 'e', 'f'];
  const nodes = ids.map(node);
  const edges = [
    edge('e1', 'root', 'a'),
    edge('e2', 'root', 'b'),
    edge('e3', 'a', 'c'),
    edge('e4', 'a', 'd'),
    edge('e5', 'b', 'e'),
    edge('e6', 'c', 'f'),
  ];
  return { nodes, edges, tree: buildMainTree(nodes, edges) };
}

describe('getAncestorChain', () => {
  it('returns self → parent → ... → root, inclusive', () => {
    const { tree } = multiBranch();
    expect(getAncestorChain(tree, 'f')).toEqual(['f', 'c', 'a', 'root']);
    expect(getAncestorChain(tree, 'a')).toEqual(['a', 'root']);
    expect(getAncestorChain(tree, 'root')).toEqual(['root']);
  });
  it('unknown node returns empty', () => {
    const { tree } = multiBranch();
    expect(getAncestorChain(tree, 'zzz')).toEqual([]);
  });
});

describe('getDescendantSet', () => {
  it('returns self + all descendants', () => {
    const { tree } = multiBranch();
    expect(getDescendantSet(tree, 'a').sort()).toEqual(['a', 'c', 'd', 'f']);
    expect(getDescendantSet(tree, 'b').sort()).toEqual(['b', 'e']);
    expect(getDescendantSet(tree, 'root').sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'root']);
    expect(getDescendantSet(tree, 'f')).toEqual(['f']);
  });
});

describe('getRelatedChain', () => {
  it('returns the undirected connected component containing the node', () => {
    const { nodes, edges } = multiBranch();
    // f 与 root 在同一连通分量（沿边忽略方向）。
    expect(getRelatedChain(nodes, edges, 'f').sort()).toEqual([
      'a', 'b', 'c', 'd', 'e', 'f', 'root',
    ]);
    expect(getRelatedChain(nodes, edges, 'root').sort()).toEqual([
      'a', 'b', 'c', 'd', 'e', 'f', 'root',
    ]);
  });
  it('isolated node returns [self] even when others are connected', () => {
    const nodes = [node('x'), node('y'), node('alone')];
    const edges = [edge('e1', 'x', 'y')];
    // alone 不在任何边的端点 → 连通分量只有自身。
    expect(getRelatedChain(nodes, edges, 'alone')).toEqual(['alone']);
    // x/y 仍在同一分量。
    expect(getRelatedChain(nodes, edges, 'x').sort()).toEqual(['x', 'y']);
  });
});

describe('getFocusViewSet', () => {
  it('focus = ancestor chain + subtree; dim = rest', () => {
    const { tree } = multiBranch();
    // 聚焦 c：祖先链 [c,a,root] ∪ 子树 [c,f] = {root,a,c,f}。
    const view = getFocusViewSet(tree, 'c');
    expect(view.focus).toEqual(['a', 'c', 'f', 'root']);
    expect(view.dim).toEqual(['b', 'd', 'e']);
  });
  it('isolated leaf: focus contains self+ancestors; dim all others', () => {
    const { tree } = multiBranch();
    // 聚焦 e（b 的独子）：focus = {root,b,e}，dim = {a,c,d,f}。
    const view = getFocusViewSet(tree, 'e');
    expect(view.focus).toEqual(['b', 'e', 'root']);
    expect(view.dim).toEqual(['a', 'c', 'd', 'f']);
  });
  it('focus on root: dim empty (whole tree focused)', () => {
    const { tree } = multiBranch();
    const view = getFocusViewSet(tree, 'root');
    expect(view.dim).toEqual([]);
    expect(view.focus).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'root']);
  });
});

describe('buildChildCountMap', () => {
  it('counts direct children per parent (source=父)', () => {
    const edges: Edge[] = [
      { id: 'e1', source: 'a', target: 'b', sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#94A3B8' } },
      { id: 'e2', source: 'a', target: 'c', sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#94A3B8' } },
      { id: 'e3', source: 'b', target: 'd', sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#94A3B8' } },
    ];
    expect(buildChildCountMap(edges)).toEqual({ a: 2, b: 1 });
  });
  it('empty edges → empty map', () => {
    expect(buildChildCountMap([])).toEqual({});
  });
  it('leaf parents absent from map; lookup defaults 0', () => {
    const edges: Edge[] = [
      { id: 'e1', source: 'root', target: 'leaf', sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#94A3B8' } },
    ];
    const m = buildChildCountMap(edges);
    expect(m.root).toBe(1);
    expect(m.leaf ?? 0).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * P1 Wave23.5 环/多父输入有界退化硬ening（cycle-layout-hang）。
 * 任何从 edges 构造树/遍历的纯函数遇到 A→B、B→A 环或多父输入，
 * 必须有界返回（不抛/不挂）且输出确定。
 * ------------------------------------------------------------------ */
describe('cycle hardening / cyclic & multi-parent inputs are bounded', () => {
  // A→B、B→A 成环；外加 C→D 无环分支做混合。
  const cycleEdges: Edge[] = [
    edge('ab', 'A', 'B'),
    edge('ba', 'B', 'A'),
    edge('cd', 'C', 'D'),
  ];
  const cycleNodes = [node('A'), node('B'), node('C'), node('D')];
  // 多父无环：A→C、B→C。
  const multiParentEdges: Edge[] = [edge('ac', 'A', 'C'), edge('bc', 'B', 'C')];
  const mpNodes = [node('A'), node('B'), node('C')];

  it('buildMainTree on a 2-cycle produces an acyclic forest (no infinite walk)', () => {
    const tree = buildMainTree(cycleNodes, cycleEdges);
    // parentId 指针不可成环：从每个节点沿 parentId 上行，链内不可重复（acyclic）、必然终止。
    for (const id of Object.keys(tree.nodes)) {
      const chainSeen = new Set<string>();
      let cur: string | null | undefined = id;
      while (cur != null) {
        expect(chainSeen.has(cur)).toBe(false);
        chainSeen.add(cur);
        cur = tree.nodes[cur]?.parentId ?? null;
      }
    }
    // 环上闭合边必须被裁决掉：A、B 中恰好一个有父（首边 wins = B 的父是 A）。
    expect(tree.nodes['B']!.parentId).toBe('A');
    expect(tree.nodes['A']!.parentId).toBe(null);
  });

  it('enumerateSubtree on cyclic-derived tree returns bounded & deterministic', () => {
    const tree = buildMainTree(cycleNodes, cycleEdges);
    const fromA = enumerateSubtree(tree, 'A');
    const fromB = enumerateSubtree(tree, 'B');
    expect([...fromA].sort()).toEqual(['A', 'B']);
    expect([...fromB].sort()).toEqual(['B']);
    // 确定性：再算一次结果一致。
    expect(enumerateSubtree(tree, 'A')).toEqual(fromA);
  });

  it('getFocusViewSet / getAncestorChain / getDescendantSet bounded on cycle', () => {
    const tree = buildMainTree(cycleNodes, cycleEdges);
    expect(getAncestorChain(tree, 'B')).toEqual(['B', 'A']);
    expect(getDescendantSet(tree, 'A').sort()).toEqual(['A', 'B']);
    const focus = getFocusViewSet(tree, 'A');
    expect(focus.focus).toContain('A');
    expect(focus.focus).toContain('B');
  });

  it('detectConflicts reports the cycle; analyzeGraph bounded on cyclic input', () => {
    const { cycles, multiParents } = detectConflicts(cycleNodes, cycleEdges);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    const analysis = analyzeGraph(cycleNodes, cycleEdges);
    expect(analysis.cycles.length).toBeGreaterThanOrEqual(1);
    // 有界：两次分析结果确定一致。
    expect(analyzeGraph(cycleNodes, cycleEdges)).toEqual(analysis);
    expect(multiParents).toEqual([]);
  });

  it('multi-parent input: buildMainTree picks first parent, traversal bounded', () => {
    const tree = buildMainTree(mpNodes, multiParentEdges);
    expect(tree.nodes['C']!.parentId).toBe('A'); // 首条入边 wins
    expect(enumerateSubtree(tree, 'A').sort()).toEqual(['A', 'C']);
    const { multiParents } = detectConflicts(mpNodes, multiParentEdges);
    expect(multiParents.length).toBe(1);
    expect(multiParents[0]!.nodeId).toBe('C');
  });
});
