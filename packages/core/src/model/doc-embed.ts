/**
 * Wave20 跨画布只读「块嵌入」（block transclusion）数据契约。
 *
 * 附加式设计（不升 schema 版本）：
 * - 嵌入块**复用既有常规节点类型**（web 侧 host type='note'），节点 type 枚举不变，
 *   旧 v4 读取方照常解析（content.data 在 BlockContentSchema 里是 z.unknown()，整体透传）；
 * - 嵌入 payload 挂在 content.data 上，形状与 P1 特殊块（equation/bookmark/...）同一模式：
 *     { kind: 'doc-embed', targetDocId, targetNodeId, titleSnapshot }
 * - 本地-first：只存引用，**不复制目标块正文**进本文档；titleSnapshot 仅为标题快照
 *   （目标块改名后经 link-writes 重命名回写刷新）。
 *
 * core 不碰 DOM/React：本文件只有类型 + 宽容解析纯函数。渲染在 web。
 */

/** 嵌入 payload 的 kind 判别值。 */
export const DOC_EMBED_KIND = 'doc-embed' as const;

/** 块嵌入 payload（content.data 的实际形状）。 */
export interface DocEmbedData {
  kind: typeof DOC_EMBED_KIND;
  /** 目标文档 id。 */
  targetDocId: string;
  /** 目标块 id。 */
  targetNodeId: string;
  /** 创建时目标块代表标题快照；悬挂时仍可展示。重命名由 link-writes 回写刷新。 */
  titleSnapshot: string;
}

/**
 * 宽容判别：data 看起来像一条合法嵌入 payload 即返回 true。
 * 刻意做结构宽松检查（不 zod 解析）：旧文档里混进的畸形 payload 交由 parse 归一化，
 * 绝不让坏数据炸掉整个文档渲染。
 */
export function isDocEmbedData(data: unknown): data is DocEmbedData {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const d = data as Record<string, unknown>;
  if (d.kind !== DOC_EMBED_KIND) return false;
  return (
    typeof d.targetDocId === 'string' &&
    d.targetDocId.length > 0 &&
    typeof d.targetNodeId === 'string' &&
    d.targetNodeId.length > 0
  );
}

/**
 * 把任意 content.data 归一化为 DocEmbedData；不是嵌入（或畸形）返回 null。
 * - 未知 kind / 缺字段 / 类型错 → null（宽容，不抛）；
 * - titleSnapshot 缺省/非字符串 → ''。
 */
export function parseDocEmbedData(data: unknown): DocEmbedData | null {
  if (!isDocEmbedData(data)) return null;
  const raw = data as unknown as Record<string, unknown>;
  return {
    kind: DOC_EMBED_KIND,
    targetDocId: raw.targetDocId as string,
    targetNodeId: raw.targetNodeId as string,
    titleSnapshot: typeof raw.titleSnapshot === 'string' ? raw.titleSnapshot : '',
  };
}
