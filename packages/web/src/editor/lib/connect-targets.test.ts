import { describe, it, expect } from 'vitest';
import type { BlockNode, Edge } from '@drawpaper/core';
import {
  collectDescendantIds,
  connectTargetTitle,
  filterConnectTargets,
  listConnectCandidates,
} from './connect-targets';

/** 构造一个带文字内容的最小节点。 */
function node(id: string, text: string, x = 0, y = 0): BlockNode {
  return {
    id,
    type: 'text',
    x,
    y,
    width: 200,
    height: 60,
    content: { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } },
    style: {},
  } as BlockNode;
}

function edge(source: string, target: string): Edge {
  return {
    id: `e_${source}_${target}`,
    source,
    target,
    sourceHandle: 'right',
    targetHandle: 'left',
    style: {},
  } as Edge;
}

/**
 * 树：A → B → C（链），另孤立块 Z。
 *  A
 *  └ B
 *    └ C
 *  Z（孤立）
 */
const nodes = [node('A', '项目总纲', 0, 0), node('B', '里程碑规划', 0, 100), node('C', '子任务细节', 0, 200), node('Z', '随手备注', 400, 0)];
const edges = [edge('A', 'B'), edge('B', 'C')];
const doc = { nodes, edges };

describe('connect-targets — 候选排除', () => {
  it('排除源块自身（self）', () => {
    const { excluded } = listConnectCandidates(doc, 'A');
    const self = excluded.find((e) => e.nodeId === 'A');
    expect(self?.reason).toBe('self');
  });

  it('排除源块的全部后代（descendant）：B、C 都不可连回 A', () => {
    const { candidates, excluded } = listConnectCandidates(doc, 'A');
    // A 的后代是 B、C；它们都不该出现在候选里。
    expect(candidates.map((c) => c.nodeId)).not.toContain('B');
    expect(candidates.map((c) => c.nodeId)).not.toContain('C');
    expect(candidates.map((c) => c.nodeId)).toContain('Z');
    const descB = excluded.find((e) => e.nodeId === 'B');
    const descC = excluded.find((e) => e.nodeId === 'C');
    expect(descB?.reason).toBe('descendant');
    expect(descC?.reason).toBe('descendant');
  });

  it('collectDescendantIds 只含后代不含自身，且多层递归', () => {
    const set = collectDescendantIds(edges, 'A');
    expect(set.has('B')).toBe(true);
    expect(set.has('C')).toBe(true);
    expect(set.has('A')).toBe(false);
    expect(set.has('Z')).toBe(false);
  });

  it('孤立源块：无后代排除，其它块全部可连', () => {
    const { candidates, excluded } = listConnectCandidates(doc, 'Z');
    expect(candidates.map((c) => c.nodeId).sort()).toEqual(['A', 'B', 'C']);
    expect(excluded.find((e) => e.nodeId === 'Z')?.reason).toBe('self');
  });

  it('源块不在文档中：不崩，全部节点为候选', () => {
    const { candidates, excluded } = listConnectCandidates(doc, 'NOPE');
    expect(candidates).toHaveLength(4);
    expect(excluded).toHaveLength(0);
  });
});

describe('connect-targets — 过滤与排序', () => {
  it('空查询：返回全部未排除候选，doc.nodes 顺序', () => {
    const out = filterConnectTargets(doc, 'A', '');
    // A 自身 + 后代 B、C 被排除 → 只剩 Z。
    expect(out.map((c) => c.nodeId)).toEqual(['Z']);
  });

  it('标题前缀命中优先于标题包含，再优先于正文包含', () => {
    // 构造：PREFIX 标题以前缀开头，IN_TITLE 标题仅包含，IN_BODY 仅正文包含。
    const n = [
      node('S', '源块', 0, 0),
      node('PREFIX', '季度目标', 0, 100),
      node('IN_TITLE', '本季度目标回顾', 0, 200),
      node('IN_BODY', '', 0, 300),
    ];
    // IN_BODY：标题（前 18 字）不含「季度」，正文第 19 字起含「季度」→ 仅正文命中（tier2）。
    (n[3] as BlockNode).content = {
      format: 'tiptap-json',
      data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '一二三四五六七八九十一二三四五六七八九十季度复盘正文' }] }] },
    };
    const d = { nodes: n, edges: [] };
    const out = filterConnectTargets(d, 'S', '季度');
    expect(out.map((c) => c.nodeId)).toEqual(['PREFIX', 'IN_TITLE', 'IN_BODY']);
  });

  it('同 tier 按 nodeId 字典序 tie-break', () => {
    const n = [
      node('S', '源', 0, 0),
      node('b1', '季度一', 0, 100),
      node('a1', '季度二', 0, 200),
    ];
    const d = { nodes: n, edges: [] };
    const out = filterConnectTargets(d, 'S', '季度');
    // 两个都是标题前缀命中（tier0）→ a1 < b1。
    expect(out.map((c) => c.nodeId)).toEqual(['a1', 'b1']);
  });

  it('查询词大小写不敏感', () => {
    const out = filterConnectTargets(doc, 'Z', '项目');
    expect(out.map((c) => c.nodeId)).toEqual(['A']);
  });

  it('无匹配候选 → 空数组（空态）', () => {
    const out = filterConnectTargets(doc, 'Z', '不存在的词xyz');
    expect(out).toEqual([]);
  });

  it('后代即使正文命中查询也被排除', () => {
    // 源 A，后代 B 标题含「里程碑」；查「里程碑」不应返回 B。
    const out = filterConnectTargets(doc, 'A', '里程碑');
    expect(out.map((c) => c.nodeId)).not.toContain('B');
  });
});

describe('connect-targets — 展示标题', () => {
  it('空内容块显示「空块」', () => {
    const empty = node('e', '');
    expect(connectTargetTitle(empty)).toBe('空块');
  });
  it('长标题截断到 18 字', () => {
    const long = node('l', '一二三四五六七八九十一二三四五六七八九十更多');
    const t = connectTargetTitle(long);
    expect(t.endsWith('…')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(20);
  });
});
