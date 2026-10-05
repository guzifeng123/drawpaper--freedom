import { nanoid } from 'nanoid';

/**
 * 文档间 / 文档内引用链接（docRef）。v2 新增。
 *
 * 这是「块内 [[双向链接]]」的规范化反链索引：
 * 主存是 Tiptap 正文里的 `docRef` mark（见下方约定）；本数组是由 web 侧从 Tiptap 内容
 * 重建出来的、便于 core/store 做反链查询与悬挂展示的索引。core 不负责从内容抽取。
 */

/** 引用链接 id 前缀。 */
export const LINK_ID_PREFIX = 'ln_' as const;

/**
 * 一条文档引用链接：sourceNodeId 块提及了 targetNodeId 块。
 * 可跨文档（targetDocId !== sourceDocId）或文档内（相等）。
 */
export interface DocRefLink {
  /** 链接 id，ln_ 前缀 nanoid。 */
  id: string;
  /** 提及所在文档。 */
  sourceDocId: string;
  /** 提及所在块。 */
  sourceNodeId: string;
  /** 被提及目标文档（可等于 sourceDocId，即文档内提及）。 */
  targetDocId: string;
  /** 被提及目标块。 */
  targetNodeId: string;
  /** 创建时目标标题快照；目标被删（悬挂）时仍可展示。 */
  targetTitle: string;
  /** 创建时间戳（ms）。 */
  createdAt: number;
}

/**
 * Tiptap `docRef` mark 约定（供链接 agent / web 渲染实现）。
 *
 * - mark name：`docRef`
 * - attrs：`{ targetDocId: string; targetNodeId: string; targetTitle: string }`
 * - 文本显示：`[[标题]]`（双括号 wiki 风格）
 * - 点击行为由 web 侧实现（跨文档跳转 / 文档内聚焦）。
 *
 * core 不依赖 @tiptap/*，仅以类型 + 注释冻结契约。
 */
export interface DocRefMarkAttrs {
  targetDocId: string;
  targetNodeId: string;
  targetTitle: string;
}

/** docRef mark 的名字（Tiptap mark type name）。 */
export const DOCREF_MARK_NAME = 'docRef' as const;

/** docRef 文本包裹符（wiki 风格 [[...]]）。 */
export const DOCREF_WRAP = { start: '[[', end: ']]' } as const;

/** 新建一条 DocRefLink。 */
export function createLink(
  fields: Omit<DocRefLink, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
): DocRefLink {
  return {
    id: fields.id ?? LINK_ID_PREFIX + nanoid(),
    sourceDocId: fields.sourceDocId,
    sourceNodeId: fields.sourceNodeId,
    targetDocId: fields.targetDocId,
    targetNodeId: fields.targetNodeId,
    targetTitle: fields.targetTitle,
    createdAt: fields.createdAt ?? Date.now(),
  };
}
