import { describe, expect, it } from 'vitest';
import type { Edge } from '@drawpaper/core';
import {
  collectConnectedSet,
  collectEdgeChain,
  collectFocusSet,
  applyManualFixed,
} from './graph-trace';

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

// 树：n1→n2→n3；n1→n4；外加 n5↔n6 的关联边（n5→n6）
const edges: Edge[] = [
  edge('e1', 'n1', 'n2'),
  edge('e2', 'n2', 'n3'),
  edge('e3', 'n1', 'n4'),
  edge('e4', 'n5', 'n6'),
];

describe('collectConnectedSet（无向连通）', () => {
  it('包含自身与沿任意边可达的节点', () => {
    const s = collectConnectedSet(edges, 'n2');
    expect(s.has('n2')).toBe(true);
    expect(s.has('n1')).toBe(true); // 父
    expect(s.has('n3')).toBe(true); // 子
    expect(s.has('n4')).toBe(true); // 兄弟（经 n1）
  });

  it('不跨不连通分量', () => {
    const s = collectConnectedSet(edges, 'n5');
    expect(s.has('n5')).toBe(true);
    expect(s.has('n6')).toBe(true);
    expect(s.has('n1')).toBe(false);
  });
});

describe('collectFocusSet（聚焦子树=自身+祖先链+后代）', () => {
  it('n2 的聚焦集 = n2 + 祖先 n1 + 后代 n3（不含兄弟 n4）', () => {
    const s = collectFocusSet(edges, 'n2');
    expect(s.has('n2')).toBe(true);
    expect(s.has('n1')).toBe(true); // 祖先
    expect(s.has('n3')).toBe(true); // 后代
    expect(s.has('n4')).toBe(false); // 兄弟不在聚焦集
  });

  it('根节点聚焦集 = 自身 + 全部后代', () => {
    const s = collectFocusSet(edges, 'n1');
    expect(s.has('n1')).toBe(true);
    expect(s.has('n2')).toBe(true);
    expect(s.has('n3')).toBe(true);
    expect(s.has('n4')).toBe(true);
    expect(s.has('n5')).toBe(false);
  });
});

describe('collectEdgeChain（悬停某条边）', () => {
  it('返回两端节点的连通并集', () => {
    const s = collectEdgeChain(edges, 'e1');
    expect(s.has('n1')).toBe(true);
    expect(s.has('n2')).toBe(true);
    expect(s.has('n3')).toBe(true);
    expect(s.has('n4')).toBe(true);
  });

  it('未知边返回空集', () => {
    expect(collectEdgeChain(edges, 'nope').size).toBe(0);
  });
});

describe('applyManualFixed（增量整理跳过手动块）', () => {
  it('从 ghost 中剔除 manualFixed 节点', () => {
    const ghosts = {
      a: { x: 0, y: 0, width: 100, height: 60 },
      b: { x: 100, y: 100, width: 100, height: 60 },
    };
    const out = applyManualFixed(ghosts, new Set(['a']));
    expect(out.a).toBeUndefined();
    expect(out.b).toBeDefined();
  });
});
