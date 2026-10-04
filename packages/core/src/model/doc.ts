import type { BlockNode } from './node.js';
import type { Edge } from './edge.js';
import type { Tag } from './tag.js';
import type { LayoutPrefs } from './layout.js';
import type { Viewport } from './viewport.js';
import type { PageSettings } from './page.js';
import type { DOC_FORMAT, CURRENT_DOC_VERSION } from './constants.js';

/** 文档级时间戳元信息。 */
export interface BoardMeta {
  createdAt: number;
  updatedAt: number;
}

/**
 * 一份 .kbnote 文档（画布）的完整数据形态。
 * 这是「内容 + 关系 + 视图偏好」的单真相；坐标可被布局引擎重算、可被 pinned 固定。
 */
export interface KBNoteDoc {
  /** 固定为 'knowledge-block-notes'。 */
  format: typeof DOC_FORMAT;
  /** schema 版本，当前 1。 */
  version: typeof CURRENT_DOC_VERSION;

  id: string;
  title: string;

  board: BoardMeta;

  nodes: BlockNode[];
  edges: Edge[];
  tags: Tag[];

  layout: LayoutPrefs;
  viewport: Viewport;
  page: PageSettings;

  /** OPFS 大 Blob 附件引用 id 列表（图片等）。JSON 内只存引用。 */
  assetRefs: string[];
}
