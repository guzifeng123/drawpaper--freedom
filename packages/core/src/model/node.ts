import type { BlockType, HandlePosition } from './constants.js';

/**
 * 块内富文本内容。
 * 真相格式为 Tiptap JSON（ProseMirror doc）。core 不依赖 @tiptap/*，
 * 这里用 `unknown` 宽松承载 doc 树，由 web 侧 @tiptap/react 负责具体形状与渲染。
 */
export interface BlockContent {
  format: 'tiptap-json';
  /** Tiptap doc 树（{ type, content, ... }）。core 不做结构性校验。 */
  data: unknown;
}

/** 块视觉样式。颜色均为可选；缺省由渲染层给默认主题。 */
export interface BlockStyle {
  /** 文字强调色（命名色或 hex）。 */
  color?: string;
  /** 背景色 hex。 */
  bg?: string;
  /** 边框色 hex。 */
  border?: string;
}

/**
 * 知识块节点。
 * 坐标 x/y/width/height 是「布局产物」——内容与位置分离，可被 pinned 固定。
 */
export interface BlockNode {
  id: string;

  type: BlockType;

  /** 画布坐标（px，未缩放世界坐标系）。 */
  x: number;
  y: number;
  /** 尺寸（px）。缩放渲染层自行处理。 */
  width: number;
  height: number;

  /** 块内富文本内容（Tiptap JSON）。 */
  content: BlockContent;

  /**
   * 父子边冗余归属（视觉嵌套容器/分组）。
   * 逻辑主树由 edges 推导；此处为「块直接放进 group 容器」的视觉归属，可为 null。
   */
  parentId: string | null;

  /** pinned：自动布局时不移动它，布局引擎为其绕行。 */
  pinned: boolean;
  /** locked：禁止编辑/移动。 */
  locked: boolean;
  /** collapsed：折叠子分支（导图长图/导出裁剪用）。 */
  collapsed: boolean;

  /** 关联 tag id 列表。 */
  tags: string[];

  style: BlockStyle;

  /**
   * 块特有可选字段（按 type 取用，core 不做判别联合收窄——web 渲染层按需读取）：
   * - todo:     { checked: boolean }
   * - image:    { src: string /* assetRef id 或 dataURL *\/, alt?: string }
   * - heading:  { level?: 1|2|3 }
   * - bookmark: { url?: string }
   * - attachment:{ assetRef?: string; name?: string }
   * - reminder: { dueAt?: number }
   * 其他 P1 类型按需在此扩展。
   */
  todo?: { checked: boolean };
  image?: { src: string; alt?: string };
  heading?: { level?: 1 | 2 | 3 };
  bookmark?: { url?: string };
  attachment?: { assetRef?: string; name?: string };
  reminder?: { dueAt?: number };
}

/** 连线端点的局部句柄（默认出/入点位置）。 */
export type { HandlePosition };
