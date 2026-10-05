/**
 * 文档级常量。`.kbnote` 文件即此结构序列化后的 JSON。
 */

/** 文件格式魔术串：所有合法 .kbnote 文件的 format 字段必须等于此值。 */
export const DOC_FORMAT = 'knowledge-block-notes' as const;

/** 当前序列化 schema 版本。旧版本文件由 serialize 模块的迁移管线逐级升级。 */
export const CURRENT_DOC_VERSION = 2 as const;

/**
 * 知识块类型联合。
 * P0 已实现：text / heading / todo / bullet / image / note / group
 *   - bullet：无序列表块（一条目即一块，区别于块内富文本里的列表）
 *   - note：便签块
 *   - group：分组容器块（视觉嵌套，子块 parentId 指向它）
 * P1 预留字符串字面量（类型层面占位，UI/渲染尚未实现）：
 *   table / code / equation / bookmark / attachment / reminder
 */
export type BlockType =
  | 'text'
  | 'heading'
  | 'todo'
  | 'bullet'
  | 'image'
  | 'note'
  | 'group'
  // --- P1 预留（未实现）---
  | 'table'
  | 'code'
  | 'equation'
  | 'bookmark'
  | 'attachment'
  | 'reminder';

/** P0 实际可用的块类型子集（供 UI 菜单/校验白名单使用）。 */
export const P0_BLOCK_TYPES: readonly BlockType[] = [
  'text',
  'heading',
  'todo',
  'bullet',
  'image',
  'note',
  'group',
] as const;

/** 连线端点（Handle）位置。边 sourceHandle / targetHandle 取值。 */
export type HandlePosition = 'top' | 'right' | 'bottom' | 'left';
