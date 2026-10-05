import { describe, it, expect } from 'vitest';
import { createDoc, createNode } from '../model/index.js';
import type { BlockNode, DocRefLink } from '../model/index.js';
import {
  backlinkKey,
  buildBacklinkIndex,
  deriveLinkId,
  extractDocLinks,
  findDanglingLinks,
  linksAffectedByDeleteDoc,
  linksAffectedByDeleteNode,
} from './links.js';

/** 构造一个内含 docRef mark 的块。 */
function nodeWithRefs(id: string, refs: Array<{ targetDocId: string; targetNodeId: string; title: string }>): BlockNode {
  const marks = refs.map((r) => ({
    type: 'docRef',
    attrs: { targetDocId: r.targetDocId, targetNodeId: r.targetNodeId, targetTitle: r.title },
  }));
  const node = createNode('text', 0, 0, {
    content: {
      format: 'tiptap-json',
      data: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(refs.length), marks }] },
        ],
      },
    },
  });
  node.id = id;
  return node;
}

describe('deriveLinkId 稳定性', () => {
  it('同一四元组 → 相同 id；不同四元组 → 不同 id', () => {
    const a = deriveLinkId('docA', 'n1', 'docB', 'n2');
    const b = deriveLinkId('docA', 'n1', 'docB', 'n2');
    expect(a).toBe(b);
    expect(a.startsWith('ln_')).toBe(true);
    expect(deriveLinkId('docA', 'n1', 'docB', 'n3')).not.toBe(a);
  });
});

describe('extractDocLinks', () => {
  it('抽取 docRef mark 并按四元组去重', () => {
    const n1 = nodeWithRefs('n1', [
      { targetDocId: 'docB', targetNodeId: 'n2', title: '目标B' },
      { targetDocId: 'docB', targetNodeId: 'n2', title: '目标B' }, // 重复
    ]);
    const links = extractDocLinks('docA', [n1], { now: () => 111 });
    expect(links).toHaveLength(1);
    const l = links[0]!;
    expect(l).toMatchObject({
      sourceDocId: 'docA',
      sourceNodeId: 'n1',
      targetDocId: 'docB',
      targetNodeId: 'n2',
      targetTitle: '目标B',
      createdAt: 111,
    });
  });

  it('无 docRef mark 的块返回空数组', () => {
    const plain = createNode('text', 0, 0);
    expect(extractDocLinks('docA', [plain])).toEqual([]);
  });

  it('重建时按稳定 id 保留旧 createdAt，不 churn', () => {
    const n1 = nodeWithRefs('n1', [{ targetDocId: 'docB', targetNodeId: 'n2', title: '旧标题' }]);
    const first = extractDocLinks('docA', [n1], { now: () => 1000 });
    expect(first).toHaveLength(1);
    // 第二次重建：title 更新、时钟变，但 id 相同、createdAt 保留。
    const n1b = nodeWithRefs('n1', [{ targetDocId: 'docB', targetNodeId: 'n2', title: '新标题' }]);
    const second = extractDocLinks('docA', [n1b], { existingLinks: first, now: () => 9999 });
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
    expect(second[0]!.createdAt).toBe(1000);
    expect(second[0]!.targetTitle).toBe('新标题');
  });

  it('缺失 targetDocId/targetNodeId 的非法 mark 被跳过', () => {
    const bad = createNode('text', 0, 0, {
      content: {
        format: 'tiptap-json',
        data: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'docRef', attrs: {} }] }] },
          ],
        },
      },
    });
    bad.id = 'n9';
    expect(extractDocLinks('docA', [bad])).toEqual([]);
  });
});

describe('buildBacklinkIndex', () => {
  it('把跨文档 links 聚合到目标块键', () => {
    const docA = createDoc('A');
    docA.nodes = [nodeWithRefs('n1', [{ targetDocId: 'docB', targetNodeId: 'nB1', title: 'B1' }])];
    docA.links = extractDocLinks('docA', docA.nodes, { now: () => 1 });
    const docB = createDoc('B');
    const idx = buildBacklinkIndex([docA, docB]);
    const hits = idx.get(backlinkKey('docB', 'nB1')) ?? [];
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sourceNodeId).toBe('n1');
    expect(idx.get(backlinkKey('docB', 'nBX')) ?? []).toEqual([]);
  });
});

describe('findDanglingLinks', () => {
  it('区分文档缺失与块缺失', () => {
    const present = createDoc('B');
    present.id = 'B';
    const b1 = createNode('text', 0, 0);
    b1.id = 'nB1';
    present.nodes = [b1];
    const links: DocRefLink[] = [
      { id: 'ln_1', sourceDocId: 'A', sourceNodeId: 'a1', targetDocId: 'B', targetNodeId: 'nB1', targetTitle: '存在', createdAt: 1 },
      { id: 'ln_2', sourceDocId: 'A', sourceNodeId: 'a1', targetDocId: 'B', targetNodeId: 'ghost', targetTitle: '块没了', createdAt: 2 },
      { id: 'ln_3', sourceDocId: 'A', sourceNodeId: 'a1', targetDocId: 'goneDoc', targetNodeId: 'x', targetTitle: '文档没了', createdAt: 3 },
    ];
    const dangling = findDanglingLinks(links, [present]);
    expect(dangling).toHaveLength(2);
    const nodeMiss = dangling.find((d) => d.link.id === 'ln_2');
    const docMiss = dangling.find((d) => d.link.id === 'ln_3');
    expect(nodeMiss?.reason).toBe('node-missing');
    expect(docMiss?.reason).toBe('doc-missing');
  });
});

describe('影响分析', () => {
  const links: DocRefLink[] = [
    { id: 'ln_1', sourceDocId: 'A', sourceNodeId: 'a1', targetDocId: 'B', targetNodeId: 'b1', targetTitle: '', createdAt: 1 },
    { id: 'ln_2', sourceDocId: 'C', sourceNodeId: 'c1', targetDocId: 'A', targetNodeId: 'a1', targetTitle: '', createdAt: 2 },
  ];

  it('删除文档 A：出链 ln_1 + 入链 ln_2', () => {
    const { outgoing, incoming } = linksAffectedByDeleteDoc('A', links);
    expect(outgoing.map((l) => l.id)).toEqual(['ln_1']);
    expect(incoming.map((l) => l.id)).toEqual(['ln_2']);
  });

  it('删除块 A/a1：出链 ln_1 + 入链 ln_2', () => {
    const { outgoing, incoming } = linksAffectedByDeleteNode('A', 'a1', links);
    expect(outgoing.map((l) => l.id)).toEqual(['ln_1']);
    expect(incoming.map((l) => l.id)).toEqual(['ln_2']);
  });
});
