import { z } from 'zod';
import type { ClientId } from './identity.js';
import { BlockNodeSchema, EdgeSchema, KBNoteDocSchema } from '../model/schema.js';

/**
 * 协作操作（CollabOp）载荷：把「对文档的一次变更」表达成可在任意标签页上幂等重放的最小单元。
 *
 * 覆盖现有命令管道的全部变更类别（store/store.ts 的 runCommand）：
 * - add-node / add-nodes  → add-node（逐条）
 * - delete-node(s)        → delete-nodes（含入射/出射边级联墓碑）
 * - update-content        → update-node { content }
 * - move-node / resize    → update-node { x,y,width,height } 或 move-nodes（批量布局）
 * - reparent              → update-node { parentId } + 边增删（B 端编排）
 * - toggle-pin/lock/collapse/todo → update-node 对应字段
 * - add-edge / delete-edge / set-edge-* → add-edge / delete-edge / update-edge
 * - rename-doc            → set-doc-meta { title }
 * - set-page-settings / pageBreaks → set-page
 *
 * 数组型字段（tags / points / pageBreaks / selection）一律按「整体值寄存器」做 LWW，
 * 不做集合合并——保证语义最简单、可收敛；B 端若需要并集可在其上再做差量。
 */

// ---- 节点字段补丁（字段级 LWW 的一个寄存器）----
export const NodePatchSchema = z
  .object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    width: z.number().finite().positive().optional(),
    height: z.number().finite().positive().optional(),
    content: z
      .object({ format: z.literal('tiptap-json'), data: z.unknown() })
      .optional(),
    // parentId: null 表示解挂到根（字段级 LWW）。
    parentId: z.string().nullable().optional(),
    pinned: z.boolean().optional(),
    locked: z.boolean().optional(),
    collapsed: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    style: z
      .object({ color: z.string().optional(), bg: z.string().optional(), border: z.string().optional() })
      .optional(),
    type: z
      .enum([
        'text', 'heading', 'todo', 'bullet', 'image', 'note', 'group',
        'table', 'code', 'equation', 'bookmark', 'attachment', 'reminder',
      ])
      .optional(),
    // 块特有可选字段；null 表示清除该字段。
    todo: z.object({ checked: z.boolean() }).nullable().optional(),
    image: z.object({ src: z.string(), alt: z.string().optional() }).nullable().optional(),
    heading: z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).nullable().optional(),
    bookmark: z.object({ url: z.string() }).nullable().optional(),
    attachment: z.object({ assetRef: z.string(), name: z.string() }).nullable().optional(),
    reminder: z.object({ dueAt: z.number() }).nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, 'update-node patch 不能为空');

export type NodeFieldPatch = z.infer<typeof NodePatchSchema>;

// ---- 边字段补丁 ----
export const CollabEdgePointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });

export const EdgePatchSchema = z
  .object({
    source: z.string().optional(),
    target: z.string().optional(),
    sourceHandle: z.enum(['top', 'right', 'bottom', 'left']).optional(),
    targetHandle: z.enum(['top', 'right', 'bottom', 'left']).optional(),
    label: z.string().optional(),
    color: z.string().optional(),
    // points: null 表示清除弯折点（回退贝塞尔）；数组整体 LWW。
    points: z.array(CollabEdgePointSchema).max(64).nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, 'update-edge patch 不能为空');

export type EdgeFieldPatch = z.infer<typeof EdgePatchSchema>;

// ---- 文档元信息 / 分页设置补丁 ----
export const DocMetaPatchSchema = z.object({ title: z.string() }).refine(
  (p) => Object.keys(p).length > 0,
  'set-doc-meta patch 不能为空',
);
export type DocMetaPatch = z.infer<typeof DocMetaPatchSchema>;

export const PagePatchSchema = z
  .object({
    orientation: z.enum(['portrait', 'landscape']).optional(),
    marginMm: z.union([z.literal(10), z.literal(15), z.literal(20)]).optional(),
    mode: z.enum(['fit', 'tiles', 'flow']).optional(),
    showPageBreak: z.boolean().optional(),
    colorMode: z.enum(['color', 'gray']).optional(),
    header: z.boolean().optional(),
    footer: z.boolean().optional(),
    showPageNumbers: z.boolean().optional(),
    edgeLabels: z.boolean().optional(),
    pageBreaks: z.array(z.object({ at: z.number() })).optional(),
    pageOrigin: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, 'set-page patch 不能为空');
export type PagePatch = z.infer<typeof PagePatchSchema>;

// ---- 操作判别联合 ----
export const CollabOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add-node'), node: BlockNodeSchema }),
  z.object({ kind: z.literal('delete-nodes'), nodeIds: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('update-node'), nodeId: z.string().min(1), patch: NodePatchSchema }),
  z.object({ kind: z.literal('add-edge'), edge: EdgeSchema }),
  z.object({ kind: z.literal('delete-edge'), edgeId: z.string().min(1) }),
  z.object({ kind: z.literal('update-edge'), edgeId: z.string().min(1), patch: EdgePatchSchema }),
  // 批量移动：布局/重排手势一次产出多个节点坐标；合并引擎按字段级 LWW 逐个落位。
  z.object({
    kind: z.literal('move-nodes'),
    positions: z
      .array(z.object({ nodeId: z.string().min(1), x: z.number().finite(), y: z.number().finite() }))
      .min(1),
  }),
  z.object({ kind: z.literal('set-doc-meta'), patch: DocMetaPatchSchema }),
  z.object({ kind: z.literal('set-page'), patch: PagePatchSchema }),
]);

export type CollabOp = z.infer<typeof CollabOpSchema>;

/** op 种类枚举（供 B 端日志/埋点）。 */
export type OpKind = CollabOp['kind'];

// ---- Presence（现场状态）----
export const RectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite(),
  h: z.number().finite(),
});
export type PresenceRect = z.infer<typeof RectSchema>;

export const PresenceSchema = z.object({
  /** 当前打开的 docId（用于跨文档标签过滤）。 */
  docId: z.string().min(1),
  /** 选中节点 id 列表（整体 LWW，不做合并）。 */
  selection: z.array(z.string()).default([]),
  /** 悬停/聚焦高亮的节点 id（null = 无）。 */
  hoverNodeId: z.string().nullish().default(null),
  /** 飞块高亮矩形（自由拖框选区，世界坐标）。 */
  blockRect: RectSchema.nullish().default(null),
  /** 心跳序号：每发一次 +1，供 B 端识别「标签页还活着」。 */
  heartbeatSeq: z.number().int().nonnegative().default(0),
});
export type PresenceState = z.infer<typeof PresenceSchema>;

// ---- Snapshot 数据（late-joiner 对齐）----
/** 基线文档复用文档主 schema 做校验。 */
export const SnapshotDataSchema = z.object({
  /** 基线文档（持有方已落盘/内存中的 doc）。 */
  baseline: KBNoteDocSchema,
  /** 基线对应的版本向量。 */
  baseVv: z.record(z.number()),
  /** 基线之后的增量 op 信封（按序重放；重复/已含按 opId 幂等跳过）。 */
  ops: z.array(z.unknown()),
});
export type SnapshotData = z.infer<typeof SnapshotDataSchema>;

// 以下类型仅用于源码可读性 re-export（B 端构造 payload 时直接用 zod infer 类型）。
export type { ClientId };
