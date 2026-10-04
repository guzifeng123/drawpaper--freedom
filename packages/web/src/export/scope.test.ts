/* eslint-disable @typescript-eslint/no-explicit-any -- 测试用最小 plain api */
import { describe, it, expect } from 'vitest';
import { computePanelsPaginate } from './useExportModel';

/**
 * bbox 范围导出：仅保留与选中节点包围盒相交的节点及其连接边。
 * computePanelsPaginate 只读 api.doc / api.selectedNodeIds，构造最小 plain object。
 */
function apiWithNodes(nodes: any[], selected: string[]) {
  return {
    doc: {
      format: 'knowledge-block-notes', version: 1, id: 'd', title: 't',
      board: { createdAt: 0, updatedAt: 0 },
      nodes, edges: nodes.length > 1 ? [{ id: 'e1', source: nodes[0].id, target: nodes[1].id }] : [],
      tags: [],
      layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
      viewport: { x: 0, y: 0, zoom: 1 },
      page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: false, colorMode: 'color', header: false, footer: false, showPageNumbers: false, edgeLabels: true, pageBreaks: [] },
      assetRefs: [],
    },
    selectedNodeIds: selected,
  } as any;
}
const node = (id: string, x: number, y: number) => ({
  id, type: 'text', x, y, width: 100, height: 50,
  content: { format: 'tiptap-json', data: { type: 'doc', content: [] } },
  parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {},
});

describe('computePanelsPaginate bbox 范围', () => {
  it('bbox 只保留选中包围盒内的节点', () => {
    const api = apiWithNodes([node('a', 0, 0), node('b', 1000, 1000)], ['a']);
    const r = computePanelsPaginate(api as any, 'bbox');
    const ids = new Set(r.pages.flatMap((p) => p.nodeIds));
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(false);
  });

  it('tighten 透传：scope=all 不报错（ smoke ）', () => {
    const api = apiWithNodes([node('a', 0, 0)], []);
    const r = computePanelsPaginate(api as any, 'all');
    expect(r.pages.length).toBeGreaterThanOrEqual(1);
  });
});
