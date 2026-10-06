import type { KBNoteDoc } from '@drawpaper/core';
import type { OverviewProvider } from './types';

/** 内存 mock OverviewProvider（组件测试 / Storybook / 开发态预览用）。 */
export class MockOverviewProvider implements OverviewProvider {
  constructor(private docs: KBNoteDoc[]) {}
  async loadAllDocs(): Promise<KBNoteDoc[]> {
    return this.docs;
  }
}

/** 构造一份最小 v2 KBNoteDoc（测试夹具）。 */
export function makeMockDoc(
  id: string,
  title: string,
  blocks: Array<{ id: string; label: string; type?: string }>,
  links: KBNoteDoc['links'] = [],
): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: 3,
    id,
    title,
    board: { createdAt: 0, updatedAt: 0 },
    nodes: blocks.map((b) => ({
      id: b.id,
      type: (b.type ?? 'text') as KBNoteDoc['nodes'][number]['type'],
      x: 0,
      y: 0,
      width: 260,
      height: 80,
      content: {
        format: 'tiptap-json',
        data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: b.label }] }] },
      },
      parentId: null,
      pinned: false,
      locked: false,
      collapsed: false,
      tags: [],
      style: {},
    })),
    edges: [],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: {
      size: 'A4',
      orientation: 'portrait',
      marginMm: 15,
      mode: 'fit',
      showPageBreak: true,
      colorMode: 'color',
      header: false,
      footer: false,
      showPageNumbers: false,
      edgeLabels: true,
      pageBreaks: [],
    },
    assetRefs: [],
    links,
    sync: { vv: {} },
  };
}
