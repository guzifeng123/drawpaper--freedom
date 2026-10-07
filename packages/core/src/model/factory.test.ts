import { describe, it, expect } from 'vitest';
import {
  createDoc,
  createNode,
  createEdge,
  createTag,
  EMPTY_TIPTAP_DOC,
  DEFAULT_NODE_SIZES,
  ID_PREFIX,
} from './factory.js';
import { DEFAULT_EDGE_COLOR } from './edge-colors.js';

describe('factory: createDoc', () => {
  it('produces a valid empty doc with doc_ prefix and defaults', () => {
    const doc = createDoc('测试');
    expect(doc.format).toBe('knowledge-block-notes');
    expect(doc.version).toBe(4);
    expect(doc.sync).toEqual({ vv: {} });
    expect(doc.id.startsWith(ID_PREFIX.doc)).toBe(true);
    expect(doc.title).toBe('测试');
    expect(doc.nodes).toEqual([]);
    expect(doc.edges).toEqual([]);
    expect(doc.tags).toEqual([]);
    expect(doc.layout).toEqual({ mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 });
    expect(doc.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(doc.page.mode).toBe('fit');
    expect(doc.assetRefs).toEqual([]);
    expect(doc.links).toEqual([]);
  });

  it('defaults title when omitted', () => {
    expect(createDoc().title).toBe('未命名画布');
  });
});

describe('factory: createNode', () => {
  it('assigns n_ prefix id and per-type default sizes', () => {
    const text = createNode('text', 0, 0);
    expect(text.id.startsWith('n_')).toBe(true);
    expect(text.width).toBe(DEFAULT_NODE_SIZES.text.width);
    expect(text.height).toBe(DEFAULT_NODE_SIZES.text.height);

    const group = createNode('group', 0, 0);
    expect(group.width).toBe(DEFAULT_NODE_SIZES.group.width);
    expect(group.height).toBe(DEFAULT_NODE_SIZES.group.height);

    const image = createNode('image', 0, 0);
    expect(image.width).toBe(DEFAULT_NODE_SIZES.image.width);
    expect(image.height).toBe(DEFAULT_NODE_SIZES.image.height);
  });

  it('gives a legal empty Tiptap doc', () => {
    const node = createNode('text', 0, 0);
    expect(node.content.format).toBe('tiptap-json');
    expect(node.content.data).toEqual({ ...EMPTY_TIPTAP_DOC });
  });

  it('fills boolean/tags/style defaults and applies overrides', () => {
    const node = createNode('text', 10, 20, { pinned: true, tags: ['t_1'] });
    expect(node.x).toBe(10);
    expect(node.y).toBe(20);
    expect(node.pinned).toBe(true);
    expect(node.locked).toBe(false);
    expect(node.collapsed).toBe(false);
    expect(node.tags).toEqual(['t_1']);
    expect(node.parentId).toBeNull();
    expect(node.style).toEqual({});
  });
});

describe('factory: createEdge', () => {
  it('uses e_ prefix, directed true, right->left handle, neutral gray', () => {
    const e = createEdge('n_1', 'n_2');
    expect(e.id.startsWith('e_')).toBe(true);
    expect(e.source).toBe('n_1');
    expect(e.target).toBe('n_2');
    expect(e.sourceHandle).toBe('right');
    expect(e.targetHandle).toBe('left');
    expect(e.directed).toBe(true);
    expect(e.label).toBe('');
    expect(e.style.color).toBe(DEFAULT_EDGE_COLOR.hex);
  });
});

describe('factory: createTag', () => {
  it('uses t_ prefix and copies name/color', () => {
    const t = createTag('灵感', '#7c3aed');
    expect(t.id.startsWith('t_')).toBe(true);
    expect(t.name).toBe('灵感');
    expect(t.color).toBe('#7c3aed');
  });
});
