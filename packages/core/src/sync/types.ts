import { z } from 'zod';

/**
 * v3 同步元数据（SyncBlock）：随 .kbnote 落盘的跨设备合并真相。
 *
 * 设计目标（契约冻结 Wave10 阶段 A）：
 * - 紧凑：字段时钟用二元组 `[lamport, clientId]` 表示，**不持久化 value**
 *   （value 已在节点/边/文档本体上，合并时直接读本体，避免双写）。
 * - 复用 Wave9 collab 的 Lamport 全序：lamport 大者胜；相等时 clientId 字典序小者胜。
 * - 墓碑：删除不进 nodes/edges 数组，而在 meta 里记 `t: [lamport, clientId]`，
 *   晚到的旧写入不能复活；删除优先（见 merge.ts）。
 * - 本文件零宿主 API、零副作用，只定义 zod schema 与纯类型。
 */

/** 一个带作者的逻辑时钟戳 = EventMarker 的持久化紧凑形式。 */
export const FMarkSchema = z.tuple([
  z.number().int().nonnegative(),
  z.string().min(1),
]);

/** `[lamport, clientId]`。与 collab.EventMarker 同语义。 */
export type FMarkTuple = [lamport: number, clientId: string];

/** 单个实体（节点/边）的同步元数据。 */
export const EntitySyncMetaSchema = z
  .object({
    /** 字段时钟：字段名 → 最后一次写入定位。缺失字段 = 未被单独时钟化（合并时回退到实体级推断）。 */
    f: z.record(FMarkSchema).optional(),
    /** 墓碑：存在即表示该实体已被删除（本体已从 nodes/edges 数组移除）。 */
    t: FMarkSchema.optional(),
  })
  .strict();

export type EntitySyncMeta = z.infer<typeof EntitySyncMetaSchema>;

/** 文档级同步块（挂在 KBNoteDoc.sync）。 */
export const SyncBlockSchema = z
  .object({
    /** 版本向量：clientId → 该客户端已观察到的最高 lamport。 */
    vv: z.record(z.number().int().nonnegative()).default(() => ({})),
    /** 文档级字段时钟（title 等）。 */
    docF: z.record(FMarkSchema).optional(),
    /** 分页设置字段时钟。 */
    pageF: z.record(FMarkSchema).optional(),
    /** 节点元数据：nodeId → meta。 */
    nodes: z.record(EntitySyncMetaSchema).optional(),
    /** 边元数据：edgeId → meta。 */
    edges: z.record(EntitySyncMetaSchema).optional(),
  })
  .strict();

export type SyncBlock = z.infer<typeof SyncBlockSchema>;

/** 空同步块（新文档 / 解析缺省时的兜底）。 */
export function emptySyncBlock(): SyncBlock {
  return { vv: {} };
}

/** EventMarker 视图：把持久化二元组还原成 collab 用的 { lamport, clientId }。 */
export function markOf(t: FMarkTuple): { lamport: number; clientId: string } {
  return { lamport: t[0], clientId: t[1] };
}

/** 节点上参与字段级 LWW 的全部字段键（与 collab/merge.ts seedNodeFields 对齐）。 */
export const NODE_CLOCKED_FIELDS = [
  'x', 'y', 'width', 'height', 'content', 'parentId',
  'pinned', 'locked', 'collapsed', 'tags', 'style', 'type',
  'todo', 'image', 'heading', 'bookmark', 'attachment', 'reminder',
] as const;

/** 边上参与字段级 LWW 的字段键（color 映射到 edge.style.color）。 */
export const EDGE_CLOCKED_FIELDS = [
  'source', 'target', 'sourceHandle', 'targetHandle', 'label', 'color', 'points',
] as const;

/** 文档级字段（title）。 */
export const DOC_CLOCKED_FIELDS = ['title'] as const;

/** 分页字段（与 collab PagePatchSchema 对齐）。 */
export const PAGE_CLOCKED_FIELDS = [
  'orientation', 'marginMm', 'mode', 'showPageBreak', 'colorMode',
  'header', 'footer', 'showPageNumbers', 'edgeLabels', 'pageBreaks', 'pageOrigin',
] as const;
