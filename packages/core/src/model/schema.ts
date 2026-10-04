import { z } from 'zod';
import { DOC_FORMAT, CURRENT_DOC_VERSION } from './constants.js';

/**
 * Zod 校验骨架。
 * 目标：parseKBNoteDoc 能安全解析未知来源 JSON，剥离未知字段、对可容错字段给默认值；
 * 结构性约束（环/多父/悬空边）由 validateGraph 在图分析层做。
 */

// ---- 块 ----
const HandlePositionSchema = z.enum(['top', 'right', 'bottom', 'left']);

const BlockContentSchema = z.object({
  format: z.literal('tiptap-json'),
  // Tiptap doc 形状由 web 侧负责，core 宽松承载。
  data: z.unknown(),
});

const BlockStyleSchema = z
  .object({
    color: z.string().optional(),
    bg: z.string().optional(),
    border: z.string().optional(),
  })
  .partial();

export const BlockNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'text',
    'heading',
    'todo',
    'bullet',
    'image',
    'note',
    'group',
    // P1 预留
    'table',
    'code',
    'equation',
    'bookmark',
    'attachment',
    'reminder',
  ]),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  content: BlockContentSchema,
  parentId: z.string().nullish().default(null),
  pinned: z.boolean().default(false),
  locked: z.boolean().default(false),
  collapsed: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  style: BlockStyleSchema.default({}),
  // 块特有可选字段（宽松：存在即透传，不做深度收窄）
  todo: z.object({ checked: z.boolean() }).optional(),
  image: z.object({ src: z.string(), alt: z.string().optional() }).optional(),
  heading: z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() }).optional(),
  bookmark: z.object({ url: z.string().optional() }).optional(),
  attachment: z.object({ assetRef: z.string().optional(), name: z.string().optional() }).optional(),
  reminder: z.object({ dueAt: z.number().optional() }).optional(),
});

// ---- 边（无 relation/line/direction 字段）----
export const EdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: HandlePositionSchema.default('right'),
  targetHandle: HandlePositionSchema.default('left'),
  label: z.string().default(''),
  directed: z.literal(true).default(true),
  style: z.object({ color: z.string() }).default({ color: '#94A3B8' }),
});

// ---- 其余顶层对象 ----
export const TagSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  color: z.string(),
});

export const LayoutPrefsSchema = z.object({
  mode: z.enum(['mindmap-right', 'mindmap-down', 'org-tree', 'radial']).default('mindmap-right'),
  rankSpacing: z.number().default(90),
  nodeSpacing: z.number().default(28),
});

export const ViewportSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  zoom: z.number().default(1),
});

export const PageSettingsSchema = z.object({
  size: z.literal('A4').default('A4'),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  marginMm: z.union([z.literal(10), z.literal(15), z.literal(20)]).default(15),
  mode: z.enum(['fit', 'tiles', 'flow']).default('fit'),
  showPageBreak: z.boolean().default(true),
  colorMode: z.enum(['color', 'gray']).default('color'),
  header: z.boolean().default(false),
  footer: z.boolean().default(false),
  showPageNumbers: z.boolean().default(false),
  pageBreaks: z.array(z.object({ at: z.number() })).default([]),
  pageOrigin: z.object({ x: z.number(), y: z.number() }).optional(),
});

export const KBNoteDocSchema = z.object({
  format: z.literal(DOC_FORMAT),
  version: z.literal(CURRENT_DOC_VERSION),
  id: z.string().min(1),
  title: z.string().default('未命名画布'),
  board: z
    .object({ createdAt: z.number(), updatedAt: z.number() })
    .default({ createdAt: 0, updatedAt: 0 }),
  nodes: z.array(BlockNodeSchema).default([]),
  edges: z.array(EdgeSchema).default([]),
  tags: z.array(TagSchema).default([]),
  layout: LayoutPrefsSchema.default({ mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 }),
  viewport: ViewportSchema.default({ x: 0, y: 0, zoom: 1 }),
  page: PageSettingsSchema.default({}),
  assetRefs: z.array(z.string()).default([]),
});

/**
 * 图校验问题类型（结构性，parse 之外的语义检查）。
 * P0 冲突处理：多父选唯一主父（其余父子边经可撤销 Command 删除）；成环选边断开。
 */
export type ValidationIssueKind =
  | 'cycle' // 父子边构成环
  | 'multi-parent' // 一个块有 >1 条入边（多父）
  | 'dangling-edge' // 边指向不存在的节点
  | 'self-loop' // source === target
  | 'duplicate-edge'; // 同一对 source→target 重复

export interface ValidationIssue {
  kind: ValidationIssueKind;
  /** 涉及的节点/边 id。 */
  nodeIds?: string[];
  edgeIds?: string[];
  message: string;
}

export interface GraphValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/**
 * 安全解析未知 JSON 为 KBNoteDoc。
 * 失败抛 ZodError（由调用方决定如何提示）。未知字段被 zod 自动剥离。
 */
export function parseKBNoteDoc(input: unknown): import('./doc.js').KBNoteDoc {
  return KBNoteDocSchema.parse(input) as import('./doc.js').KBNoteDoc;
}

/** 宽松解析，不抛错，返回是否成功与产物。 */
export function safeParseKBNoteDoc(
  input: unknown,
): z.SafeParseReturnType<unknown, import('./doc.js').KBNoteDoc> {
  return KBNoteDocSchema.safeParse(input) as z.SafeParseReturnType<unknown, import('./doc.js').KBNoteDoc>;
}

/**
 * 校验图结构：环 / 多父 / 悬空边 / 自环 / 重复边。
 * 【Wave1-A 实现 TODO】当前为占位：返回空 issue 列表骨架，实现留给后续 agent。
 */
export function validateGraph(_doc: import('./doc.js').KBNoteDoc): GraphValidationResult {
  // TODO(wave1-a): 建邻接表 → DFS 找环 / 统计入度 >1 / 边端点存在性 / source===target / 去重。
  return { ok: true, issues: [] };
}
