import { describe, it, expect } from 'vitest';
import {
  EDGE_COLORS,
  DEFAULT_EDGE_COLOR,
  parseKBNoteDoc,
  DOC_FORMAT,
  CURRENT_DOC_VERSION,
} from './index.js';
import { serializeKBNote, parseKBNote } from './serialize/index.js';

function minimalDoc() {
  return {
    format: DOC_FORMAT,
    version: CURRENT_DOC_VERSION,
    id: 'doc_1',
    title: '最小画布',
    board: { createdAt: 0, updatedAt: 0 },
    nodes: [
      {
        id: 'n_1',
        type: 'text',
        x: 0,
        y: 0,
        width: 260,
        height: 80,
        content: { format: 'tiptap-json', data: { type: 'doc' } },
        parentId: null,
        pinned: false,
        locked: false,
        collapsed: false,
        tags: [],
        style: {},
      },
    ],
    edges: [
      {
        id: 'e_1',
        source: 'n_1',
        target: 'n_2',
        sourceHandle: 'right',
        targetHandle: 'left',
        label: '',
        directed: true,
        style: { color: '#94A3B8' },
      },
    ],
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

describe('edge colors', () => {
  it('provides 5 sample colors + default neutral', () => {
    expect(EDGE_COLORS).toHaveLength(5);
    expect(DEFAULT_EDGE_COLOR.hex).toBe('#94A3B8');
  });
});

describe('parseKBNoteDoc', () => {
  it('accepts a minimal valid doc and fills defaults', () => {
    const doc = parseKBNoteDoc(minimalDoc());
    expect(doc.id).toBe('doc_1');
    expect(doc.nodes).toHaveLength(1);
    expect(doc.edges[0]?.style.color).toBe('#94A3B8');
    // unknown/absent fields defaulted
    expect(doc.board.createdAt).toBe(0);
  });

  it('rejects a doc with wrong format', () => {
    const bad = { ...minimalDoc(), format: 'wrong-format' };
    expect(() => parseKBNoteDoc(bad)).toThrow();
  });

  it('round-trips serialize / parseKBNote', () => {
    const doc = parseKBNoteDoc(minimalDoc());
    const text = serializeKBNote(doc);
    const { doc: back, migrationNotes } = parseKBNote(text);
    expect(back.id).toBe('doc_1');
    expect(migrationNotes).toEqual([]);
  });
});
