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
  linksAffectedByDeleteNodes,
  stripDocRefMarks,
  retitleDocRefMarks,
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

  it('批量删除块：聚合同文档多个待删块的影响', () => {
    const more: DocRefLink[] = [
      ...links,
      // 指向待删块 a2 的入链
      { id: 'ln_3', sourceDocId: 'C', sourceNodeId: 'c9', targetDocId: 'A', targetNodeId: 'a2', targetTitle: '', createdAt: 3 },
      // 指向保留块 a3 的入链（不应命中）
      { id: 'ln_4', sourceDocId: 'C', sourceNodeId: 'c9', targetDocId: 'A', targetNodeId: 'a3', targetTitle: '', createdAt: 4 },
    ];
    const { outgoing, incoming } = linksAffectedByDeleteNodes('A', new Set(['a1', 'a2']), more);
    expect(outgoing.map((l) => l.id)).toEqual(['ln_1']);
    expect(incoming.map((l) => l.id).sort()).toEqual(['ln_2', 'ln_3']);
  });
});

// ---- 级联移除变换（stripDocRefMarks） ----

/** 构造一份文档，nodes 各含一个指向 (targetDoc,targetNode) 的 docRef mark 文本节点。 */
function docWithMarks(
  docId: string,
  specs: Array<{ nodeId: string; text: string; targetDocId: string; targetNodeId: string; title: string }>,
) {
  const doc = createDoc('T');
  doc.id = docId;
  doc.nodes = specs.map((s) =>
    nodeWithRefs(s.nodeId, [{ targetDocId: s.targetDocId, targetNodeId: s.targetNodeId, title: s.title }]),
  );
  // nodeWithRefs 把 text 固定为 'x'*n；这里替换成可读文本。
  for (let i = 0; i < specs.length; i++) {
    const data = doc.nodes[i]!.content.data as { content: Array<{ content: Array<{ text: string }> }> };
    data.content[0]!.content![0]!.text = specs[i]!.text;
  }
  return doc;
}

describe('stripDocRefMarks 级联移除', () => {
  it('摘除命中 link id 集合的 docRef mark，保留文本与其他 mark', () => {
    const doc = docWithMarks('docA', [
      { nodeId: 'n1', text: '[[旧B]]', targetDocId: 'docB', targetNodeId: 'b1', title: '旧B' },
      { nodeId: 'n2', text: '[[保留]]', targetDocId: 'docC', targetNodeId: 'c1', title: '保留' },
    ]);
    const victimId = deriveLinkId('docA', 'n1', 'docB', 'b1');
    const { doc: out, count } = stripDocRefMarks(doc, new Set([victimId]));
    expect(count).toBe(1);
    // 重建 links：被摘的消失，保留的还在。
    const rebuilt = extractDocLinks('docA', out.nodes, { now: () => 1 });
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]!.targetDocId).toBe('docC');
    // 文本保留（退化为纯文本，不吞字）。
    const n1 = out.nodes.find((n) => n.id === 'n1')!;
    expect(extractPlainTextOf(n1)).toContain('[[旧B]]');
  });

  it('无命中时原样返回（结构共享，节点引用不变）', () => {
    const doc = docWithMarks('docA', [
      { nodeId: 'n1', text: '[[x]]', targetDocId: 'docB', targetNodeId: 'b1', title: 'x' },
    ]);
    const before = doc.nodes[0];
    const { doc: out, count } = stripDocRefMarks(doc, new Set(['ln_nope']));
    expect(count).toBe(0);
    expect(out.nodes[0]).toBe(before);
  });

  it('mark 是该文本节点唯一 mark 时，移除 marks 数组', () => {
    const doc = docWithMarks('docA', [
      { nodeId: 'n1', text: '[[x]]', targetDocId: 'docB', targetNodeId: 'b1', title: 'x' },
    ]);
    const victimId = deriveLinkId('docA', 'n1', 'docB', 'b1');
    const { doc: out } = stripDocRefMarks(doc, new Set([victimId]));
    const data = out.nodes[0]!.content.data as { content: Array<{ content: Array<{ marks?: unknown[] }> }> };
    expect(data.content[0]!.content![0]!.marks ?? []).toEqual([]);
  });
});

describe('retitleDocRefMarks 重命名重索引', () => {
  it('标准 [[...]] 包裹：attrs.targetTitle 与可见文本同步刷新', () => {
    const doc = docWithMarks('docA', [
      { nodeId: 'n1', text: '[[旧B]]', targetDocId: 'docB', targetNodeId: 'b1', title: '旧B' },
    ]);
    const { doc: out, count } = retitleDocRefMarks(doc, 'docB', 'b1', '新标题');
    expect(count).toBe(1);
    const data = out.nodes[0]!.content.data as {
      content: Array<{ content: Array<{ text: string; marks: Array<{ attrs: { targetTitle: string } }> }> }>;
    };
    const textNode = data.content[0]!.content![0]!;
    expect(textNode.text).toBe('[[新标题]]');
    expect(textNode.marks![0]!.attrs.targetTitle).toBe('新标题');
    // 重建 links 即得到刷新过 targetTitle 的反链索引。
    const rebuilt = extractDocLinks('docA', out.nodes, { now: () => 1 });
    expect(rebuilt[0]!.targetTitle).toBe('新标题');
  });

  it('用户自定义文本（非标准包裹）只刷 attrs，不动可见文本', () => {
    const doc = docWithMarks('docA', [
      { nodeId: 'n1', text: '点这里看目标', targetDocId: 'docB', targetNodeId: 'b1', title: '旧B' },
    ]);
    const { doc: out, count } = retitleDocRefMarks(doc, 'docB', 'b1', '新标题');
    expect(count).toBe(1);
    const data = out.nodes[0]!.content.data as {
      content: Array<{ content: Array<{ text: string; marks: Array<{ attrs: { targetTitle: string } }> }> }>;
    };
    expect(data.content[0]!.content![0]!.text).toBe('点这里看目标');
    expect(data.content[0]!.content![0]!.marks![0]!.attrs.targetTitle).toBe('新标题');
  });

  it('只改写命中目标键的 mark，其他目标不受影响', () => {
    const doc = docWithMarks('docA', [
      { nodeId: 'n1', text: '[[旧B]]', targetDocId: 'docB', targetNodeId: 'b1', title: '旧B' },
      { nodeId: 'n2', text: '[[其他]]', targetDocId: 'docC', targetNodeId: 'c1', title: '其他' },
    ]);
    const { count } = retitleDocRefMarks(doc, 'docB', 'b1', '新标题');
    expect(count).toBe(1);
    const rebuilt = extractDocLinks('docA', doc.nodes, { now: () => 1 });
    // 第二个块原样：未命中的目标标题不动。
    const other = rebuilt.find((l) => l.targetDocId === 'docC')!;
    expect(other.targetTitle).toBe('其他');
  });
});

/** 读取块纯文本（测试内联，避免依赖 web 侧 search-index）。 */
function extractPlainTextOf(n: BlockNode): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const x = node as { text?: string; content?: unknown[] };
    if (typeof x.text === 'string') parts.push(x.text);
    if (Array.isArray(x.content)) x.content.forEach(walk);
  };
  walk(n.content.data);
  return parts.join('');
}
