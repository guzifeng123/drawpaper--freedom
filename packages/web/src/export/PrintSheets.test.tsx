import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { KBNoteDoc, PageSettings, PaginateResult } from '@drawpaper/core';
import { PrintSheets } from './PrintSheets';

function makeDoc(): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: 2,
    id: 'd1',
    title: '测试文档',
    board: { createdAt: 0, updatedAt: 0 },
    nodes: [
      {
        id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50,
        content: { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '块一' }] }] } },
        parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {},
      },
      {
        id: 'n2', type: 'text', x: 150, y: 0, width: 100, height: 50,
        content: { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '块二' }] }] } },
        parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {},
      },
      // 折叠子树内的块：不应出现在打印里（core 已剔除，但渲染端也不应拿到它）
      {
        id: 'n_hidden', type: 'text', x: 9999, y: 9999, width: 100, height: 50,
        content: { format: 'tiptap-json', data: { type: 'doc' } },
        parentId: null, pinned: false, locked: false, collapsed: true, tags: [], style: {},
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'right', targetHandle: 'left', label: '父子', directed: true, style: { color: '#94A3B8' } },
    ],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: {} as PageSettings,
    assetRefs: [],
    links: [],
  };
}

function makeResult(): PaginateResult {
  return {
    totalPages: 2,
    orphans: [{ nodeId: 'n2', severity: 'warn', message: '孤块' }],
    notes: [],
    pages: [
      {
        index: 0,
        pageNumber: 1,
        worldRect: { x: 0, y: 0, width: 500, height: 700 },
        nodeIds: ['n1'],
        edgeIds: [],
        continuations: [{ token: 'A', edgeId: 'e1', pageIndex: 0, x: 140, y: 25, peerPageIndex: 1 }],
        scale: 1,
      },
      {
        index: 1,
        pageNumber: 2,
        worldRect: { x: 500, y: 0, width: 500, height: 700 },
        nodeIds: ['n2'],
        edgeIds: [],
        continuations: [{ token: 'A', edgeId: 'e1', pageIndex: 1, x: 10, y: 25, peerPageIndex: 0 }],
        scale: 1,
      },
    ],
  };
}

const baseSettings: PageSettings = {
  size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'tiles',
  showPageBreak: false, colorMode: 'color', header: true, footer: true,
  showPageNumbers: true,
  edgeLabels: true,
  pageBreaks: [],
};

describe('PrintSheets', () => {
  it('渲染页数与页码', () => {
    render(<PrintSheets result={makeResult()} doc={makeDoc()} settings={baseSettings} edgeLabelsVisible />);
    const sheets = document.querySelectorAll('.drawpaper-print-container .sheet');
    expect(sheets.length).toBe(2);
    expect(document.body.textContent).toContain('第 1 / 2 页');
    expect(document.body.textContent).toContain('第 2 / 2 页');
  });

  it('跨页续接标记成对出现（同 token，圆圈内显示成对短编号）', () => {
    render(<PrintSheets result={makeResult()} doc={makeDoc()} settings={baseSettings} edgeLabelsVisible />);
    const circles = document.querySelectorAll('.drawpaper-print-container circle');
    expect(circles.length).toBe(2);
    // token 'A' 是首个出现的 cont → 两页圆圈都显示编号 1。
    const contTexts = Array.from(
      document.querySelectorAll('.drawpaper-print-container .sheet svg g'),
    )
      .filter((g) => g.querySelector('circle'))
      .map((g) => g.textContent);
    expect(contTexts).toEqual(['1', '1']);
  });

  it('孤块黄色角标', () => {
    render(<PrintSheets result={makeResult()} doc={makeDoc()} settings={baseSettings} edgeLabelsVisible />);
    expect(document.querySelectorAll('[data-orphan-badge]').length).toBe(1);
  });

  it('折叠子树节点缺席（n_hidden 不在 DOM）', () => {
    render(<PrintSheets result={makeResult()} doc={makeDoc()} settings={baseSettings} edgeLabelsVisible />);
    expect(document.querySelector('[data-node-id="n_hidden"]')).toBeNull();
    expect(document.querySelector('[data-node-id="n1"]')).not.toBeNull();
  });

  it('黑白模式容器加 .tp-gray', () => {
    render(
      <PrintSheets
        result={makeResult()}
        doc={makeDoc()}
        settings={{ ...baseSettings, colorMode: 'gray' }}
        edgeLabelsVisible
      />,
    );
    expect(document.querySelector('.drawpaper-print-container')?.classList.contains('tp-gray')).toBe(true);
  });
});
