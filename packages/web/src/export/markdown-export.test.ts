import { describe, it, expect } from 'vitest';
import type { KBNoteDoc, BlockNode } from '@drawpaper/core';
import { docToMarkdown } from './markdown-export';

function textNode(id: string, text: string, over: Partial<BlockNode> = {}): BlockNode {
  return {
    id,
    type: 'note',
    x: 0,
    y: 0,
    width: 240,
    height: 120,
    content: { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
    ...over,
  } as BlockNode;
}

function embedNode(id: string): BlockNode {
  return {
    ...textNode(id, ''),
    type: 'note',
    content: {
      format: 'tiptap-json',
      data: { kind: 'doc-embed', targetDocId: 'doc_A', targetNodeId: 'n_A1', titleSnapshot: '目标块标题' },
    },
  };
}

function doc(nodes: BlockNode[]): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: 4,
    id: 'doc_B',
    title: '画布B',
    board: { createdAt: 0, updatedAt: 0 },
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: true, colorMode: 'color', header: false, footer: false, showPageNumbers: false, edgeLabels: true, pageBreaks: [] },
    assetRefs: [],
    nodes,
    edges: [],
  } as unknown as KBNoteDoc;
}

describe('docToMarkdown 块嵌入（Wave20）', () => {
  it('嵌入块输出引用块：嵌入自「画布名」+ 标题快照双链行', () => {
    const md = docToMarkdown(doc([embedNode('nE')]), { docTitles: { doc_A: '源画布A' } });
    expect(md).toContain('> 嵌入自「源画布A」');
    expect(md).toContain('> [[目标块标题]]');
    // 不复制对方正文。
    expect(md).not.toContain('目标块标题正文');
  });

  it('缺 docTitles 时降级为标题快照（不炸）', () => {
    const md = docToMarkdown(doc([embedNode('nE')]));
    expect(md).toContain('> 嵌入自「目标块标题」');
    expect(md).toContain('> [[目标块标题]]');
  });

  it('普通便签仍按原引用块规则输出（回归）', () => {
    const md = docToMarkdown(doc([textNode('n1', '便签正文')]));
    expect(md).toContain('> 便签正文');
  });
});
