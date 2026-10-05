import { nanoid } from 'nanoid';
import { DOC_FORMAT, CURRENT_DOC_VERSION } from './constants.js';
import type { BlockType } from './constants.js';
import { DEFAULT_EDGE_COLOR } from './edge-colors.js';
import type { BlockNode } from './node.js';
import type { Edge } from './edge.js';
import type { Tag } from './tag.js';
import type { KBNoteDoc } from './doc.js';

/**
 * 工厂函数：构造「合法、可直接落库」的模型对象。
 * id 统一用 nanoid 加业务前缀（doc_ / n_ / e_ / t_），保证可辨识与可单测。
 */

/** 新文档 / 节点 / 边 / 标签的 id 前缀。 */
export const ID_PREFIX = {
  doc: 'doc_',
  node: 'n_',
  edge: 'e_',
  tag: 't_',
} as const;

/** 合法的空 Tiptap doc（core 不校验其内部结构，仅保证形状合法）。 */
export const EMPTY_TIPTAP_DOC = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
} as const;

/** 各类型新建块的默认尺寸（px）。 */
export const DEFAULT_NODE_SIZES: Readonly<Record<BlockType, { width: number; height: number }>> = {
  text: { width: 260, height: 80 },
  heading: { width: 260, height: 48 },
  todo: { width: 260, height: 60 },
  bullet: { width: 260, height: 60 },
  image: { width: 240, height: 180 },
  note: { width: 240, height: 160 },
  group: { width: 320, height: 200 },
  // P1 预留类型统一回退到文本尺寸
  table: { width: 260, height: 80 },
  code: { width: 260, height: 80 },
  equation: { width: 260, height: 80 },
  bookmark: { width: 260, height: 80 },
  attachment: { width: 260, height: 80 },
  reminder: { width: 260, height: 80 },
};

/** createNode 的可覆盖字段（id/type/x/y/width/height 由参数决定）。 */
export type NodeOverrides = Partial<Omit<BlockNode, 'id' | 'type' | 'x' | 'y' | 'width' | 'height'>>;

/** createEdge 的可覆盖字段（id/source/target 由参数决定）。 */
export type EdgeOverrides = Partial<Omit<Edge, 'id' | 'source' | 'target'>>;

/** 新建一份空文档。title 缺省为「未命名画布」。 */
export function createDoc(title: string = '未命名画布'): KBNoteDoc {
  const now = Date.now();
  return {
    format: DOC_FORMAT,
    version: CURRENT_DOC_VERSION,
    id: ID_PREFIX.doc + nanoid(),
    title,
    board: { createdAt: now, updatedAt: now },
    nodes: [],
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
    links: [],
  };
}

/**
 * 新建一个块节点。type 决定默认尺寸；content 给合法空 Tiptap doc。
 * partial 可覆盖 style/tags/parentId/pinned 等。
 */
export function createNode(type: BlockType, x: number, y: number, partial: NodeOverrides = {}): BlockNode {
  const size = DEFAULT_NODE_SIZES[type] ?? { width: 260, height: 80 };
  return {
    id: ID_PREFIX.node + nanoid(),
    type,
    x,
    y,
    width: size.width,
    height: size.height,
    content: { format: 'tiptap-json', data: { ...EMPTY_TIPTAP_DOC } },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
    ...partial,
  };
}

/**
 * 新建一条父子边。source=父、target=子；默认 right→left、有向、中性灰。
 */
export function createEdge(source: string, target: string, partial: EdgeOverrides = {}): Edge {
  return {
    id: ID_PREFIX.edge + nanoid(),
    source,
    target,
    sourceHandle: 'right',
    targetHandle: 'left',
    label: '',
    directed: true,
    style: { color: DEFAULT_EDGE_COLOR.hex },
    ...partial,
  };
}

/** 新建一个标签。 */
export function createTag(name: string, color: string): Tag {
  return { id: ID_PREFIX.tag + nanoid(), name, color };
}
