import { describe, it, expect } from 'vitest';
import {
  aggregateOverview,
  computeView,
  collapseToDocs,
  expandDoc,
  collapseDoc,
  maybeCollapseForScale,
  layoutOverviewView,
  searchOverview,
  blockFqid,
  docClusterId,
  OVERVIEW_NODE_SOFT_LIMIT,
  type OverviewDocInput,
} from './overview.js';
import type { DocRefLink, Edge } from '../model/index.js';

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

function link(
  id: string,
  sourceDocId: string,
  sourceNodeId: string,
  targetDocId: string,
  targetNodeId: string,
): DocRefLink {
  return {
    id,
    sourceDocId,
    sourceNodeId,
    targetDocId,
    targetNodeId,
    targetTitle: 't',
    createdAt: 0,
  };
}

/**
 * 两份文档：
 *  docA: a1 → a2 → a3（父子），a1 提及 docB 的 b1（跨文档 docref）
 *  docB: b1 → b2（父子）
 */
function twoDocs(): OverviewDocInput[] {
  return [
    {
      id: 'docB',
      title: 'B 文档',
      nodes: [
        { id: 'b1', type: 'text', label: 'B 块一' },
        { id: 'b2', type: 'todo', label: 'B 块二' },
      ],
      edges: [edge('e_b12', 'b1', 'b2')],
      links: [],
    },
    {
      id: 'docA',
      title: 'A 文档',
      nodes: [
        { id: 'a1', type: 'heading', label: 'A 块一' },
        { id: 'a2', type: 'text', label: 'A 块二' },
        { id: 'a3', type: 'text', label: 'A 块三' },
      ],
      edges: [edge('e_a12', 'a1', 'a2'), edge('e_a23', 'a2', 'a3')],
      links: [link('ln_1', 'docA', 'a1', 'docB', 'b1')],
    },
  ];
}

describe('aggregateOverview', () => {
  it('flattens docs into fqid block nodes + parent edges + docref edges', () => {
    const model = aggregateOverview(twoDocs());
    expect(model.docs.map((d) => d.docId).sort()).toEqual(['docA', 'docB']);
    expect(model.blockNodes.map((n) => n.id).sort()).toEqual([
      blockFqid('docA', 'a1'),
      blockFqid('docA', 'a2'),
      blockFqid('docA', 'a3'),
      blockFqid('docB', 'b1'),
      blockFqid('docB', 'b2'),
    ]);
    // parent edges within docs
    expect(model.parentEdges).toHaveLength(3);
    // docref edge across docs
    expect(model.docrefEdges).toHaveLength(1);
    const dr = model.docrefEdges[0]!;
    expect(dr.source).toBe(blockFqid('docA', 'a1'));
    expect(dr.target).toBe(blockFqid('docB', 'b1'));
    expect(dr.type).toBe('docref');
  });

  it('drops docref edges whose endpoints are absent', () => {
    const docs: OverviewDocInput[] = [
      {
        id: 'docA',
        title: 'A',
        nodes: [{ id: 'a1', type: 'text', label: 'a1' }],
        edges: [],
        // target node x missing from any doc
        links: [link('ln_x', 'docA', 'a1', 'docA', 'missing')],
      },
    ];
    const model = aggregateOverview(docs);
    expect(model.docrefEdges).toHaveLength(0);
  });

  it('is deterministic: same input twice → deep equal', () => {
    expect(aggregateOverview(twoDocs())).toEqual(aggregateOverview(twoDocs()));
  });
});

describe('computeView / collapse / expand', () => {
  it('expanded view shows all blocks + internal parent edges; docref links blocks', () => {
    const model = aggregateOverview(twoDocs());
    const view = computeView(model, new Set());
    expect(view.nodes).toHaveLength(5);
    expect(view.edges.filter((e) => e.type === 'parent')).toHaveLength(3);
    // docref edge connects actual blocks
    const dr = view.edges.find((e) => e.type === 'docref')!;
    expect(dr.source).toBe(blockFqid('docA', 'a1'));
    expect(dr.target).toBe(blockFqid('docB', 'b1'));
  });

  it('collapseToDocs: one cluster node per doc, internal edges dropped, docref remapped to clusters', () => {
    const model = aggregateOverview(twoDocs());
    const view = collapseToDocs(model);
    expect(view.nodes.map((n) => n.id).sort()).toEqual([docClusterId('docA'), docClusterId('docB')]);
    expect(view.edges.filter((e) => e.type === 'parent')).toHaveLength(0);
    // docref between two docs → cluster-to-cluster
    const dr = view.edges.find((e) => e.type === 'docref')!;
    expect(dr.source).toBe(docClusterId('docA'));
    expect(dr.target).toBe(docClusterId('docB'));
  });

  it('partial collapse: collapsed doc clusters, expanded doc blocks; docref remaps only collapsed side', () => {
    const model = aggregateOverview(twoDocs());
    // collapse only docA
    const view = computeView(model, new Set(['docA']));
    // docA cluster + docB's two blocks
    expect(view.nodes.map((n) => n.id).sort()).toEqual([
      blockFqid('docB', 'b1'),
      blockFqid('docB', 'b2'),
      docClusterId('docA'),
    ]);
    // docref source (docA collapsed) → cluster; target (docB expanded) → block
    const dr = view.edges.find((e) => e.type === 'docref')!;
    expect(dr.source).toBe(docClusterId('docA'));
    expect(dr.target).toBe(blockFqid('docB', 'b1'));
  });

  it('expandDoc / collapseDoc are pure set operations and idempotent', () => {
    let set = new Set(['docA', 'docB']);
    set = expandDoc(set, 'docA');
    expect([...set]).toEqual(['docB']);
    set = expandDoc(set, 'docA');
    expect([...set]).toEqual(['docB']); // idempotent
    set = collapseDoc(set, 'docA');
    expect([...set].sort()).toEqual(['docA', 'docB']);
  });
});

describe('maybeCollapseForScale', () => {
  it('does not collapse when under soft limit', () => {
    const model = aggregateOverview(twoDocs());
    const { view, collapsed } = maybeCollapseForScale(model, new Set());
    expect(collapsed).toBe(false);
    expect(view.nodes.length).toBe(5);
  });

  it('collapses to docs when visible blocks exceed soft limit', () => {
    // 3 docs × 300 blocks = 900 blocks > 600
    const docs: OverviewDocInput[] = ['d1', 'd2', 'd3'].map((id) => ({
      id,
      title: id,
      nodes: Array.from({ length: 300 }, (_, i) => ({
        id: `n${i}`,
        type: 'text' as const,
        label: `block ${i}`,
      })),
      edges: [],
      links: [],
    }));
    const model = aggregateOverview(docs);
    expect(model.blockNodes.length).toBe(900);
    const { view, collapsed } = maybeCollapseForScale(model, new Set(), OVERVIEW_NODE_SOFT_LIMIT);
    expect(collapsed).toBe(true);
    expect(view.nodes.map((n) => n.kind)).toEqual(['doc', 'doc', 'doc']);
  });

  it('is deterministic', () => {
    const model = aggregateOverview(twoDocs());
    expect(maybeCollapseForScale(model, new Set())).toEqual(maybeCollapseForScale(model, new Set()));
  });
});

describe('layoutOverviewView', () => {
  it('positions clusters on a circle; expanded blocks in grid; no overlap among blocks', () => {
    const model = aggregateOverview(twoDocs());
    const view = computeView(model, new Set(['docA'])); // docA cluster + docB blocks
    const pos = layoutOverviewView(view);
    // every visible node has coordinates
    for (const n of view.nodes) expect(pos[n.id]).toBeDefined();
    // cluster and blocks distinct positions
    const coords = new Set(Object.values(pos).map((p) => `${p.x},${p.y}`));
    expect(coords.size).toBe(view.nodes.length);
  });

  it('is deterministic', () => {
    const model = aggregateOverview(twoDocs());
    const view = computeView(model, new Set());
    expect(layoutOverviewView(view)).toEqual(layoutOverviewView(view));
  });
});

describe('searchOverview', () => {
  it('matches block labels and recommends their docs', () => {
    const model = aggregateOverview(twoDocs());
    const r = searchOverview(model, 'B 块');
    expect(r.matchedBlockIds).toEqual([blockFqid('docB', 'b1'), blockFqid('docB', 'b2')]);
    expect(r.recommendedDocIds).toEqual(['docB']);
  });

  it('matches doc title and recommends the doc', () => {
    const model = aggregateOverview(twoDocs());
    const r = searchOverview(model, 'A 文档');
    expect(r.recommendedDocIds).toEqual(['docA']);
    expect(r.matchedBlockIds).toHaveLength(0);
  });

  it('empty query returns empty', () => {
    const model = aggregateOverview(twoDocs());
    expect(searchOverview(model, '   ')).toEqual({ matchedBlockIds: [], recommendedDocIds: [] });
  });
});
