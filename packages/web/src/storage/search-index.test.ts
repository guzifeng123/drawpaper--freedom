import { describe, it, expect } from 'vitest';
import type { KBNoteDoc } from '@drawpaper/core';
import { extractPlainText, buildIndex, searchDocs } from './search-index';

function docWith(blocks: Array<{ id: string; data: unknown }>): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: 1,
    id: 'd1',
    title: 't',
    board: { createdAt: 0, updatedAt: 0 },
    nodes: blocks.map((b) => ({
      id: b.id,
      type: 'text' as const,
      x: 0,
      y: 0,
      width: 220,
      height: 80,
      content: { format: 'tiptap-json', data: b.data },
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
      pageBreaks: [],
    },
    assetRefs: [],
  };
}

describe('extractPlainText', () => {
  it('extracts paragraph text', () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '你好世界' }] },
      ],
    };
    expect(extractPlainText(json)).toBe('你好世界');
  });

  it('walks nested heading / list / todo', () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: '标题' }] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '项目一' }] }] },
          ],
        },
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '待办' }] }] },
          ],
        },
      ],
    };
    expect(extractPlainText(json)).toBe('标题 项目一 待办');
  });

  it('returns empty string for empty doc', () => {
    expect(extractPlainText({ type: 'doc' })).toBe('');
    expect(extractPlainText(null)).toBe('');
  });
});

describe('MiniSearch build / search', () => {
  it('builds index and finds matching node with snippet', () => {
    const doc = docWith([
      { id: 'n1', data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '思维导图布局算法' }] }] } },
      { id: 'n2', data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '早餐吃什么' }] }] } },
    ]);
    const index = buildIndex(doc);
    const hits = searchDocs(index, '思维导图');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.nodeId).toBe('n1');
    expect(hits[0]!.snippet).toContain('思维导图');
  });

  it('returns empty for blank query', () => {
    const index = buildIndex(docWith([{ id: 'n1', data: { type: 'doc' } }]));
    expect(searchDocs(index, '   ')).toEqual([]);
  });
});
