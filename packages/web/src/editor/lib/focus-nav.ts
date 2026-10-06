import type { BlockNode, Edge } from '@drawpaper/core';

/**
 * focus-nav —— 块级键盘焦点导航的纯函数（Wave9 无障碍）。
 *
 * 方向语义（Alt+方向键，规划文档未约定，按行业 tree 导航惯例实现并文档化）：
 *  - Alt+ArrowRight = 进入第一个子块（下钻父子树）
 *  - Alt+ArrowLeft  = 返回父块（上溯）
 *  - Alt+ArrowUp    = 同级上一个兄弟（同父，按世界坐标 y 升序）
 *  - Alt+ArrowDown  = 同级下一个兄弟（同父，按世界坐标 y 升序）
 *
 * 边只有父子一种语义：edge.source=父，edge.target=子。
 * 多父冲突下「父」取第一条入边的 source（与 mainTree 选主父策略一致）。
 *
 * 纯函数、零 DOM、零 React，便于 vitest 单测；DOM 聚焦/滚动由调用方做。
 */

export type FocusNavDirection = 'parent' | 'firstChild' | 'prevSibling' | 'nextSibling';

export interface FocusNavDoc {
  nodes: BlockNode[];
  edges: Edge[];
}

/** 找某块的直接父 id（第一条入边的 source；无父返回 null）。 */
export function findParentId(doc: FocusNavDoc, id: string): string | null {
  for (const e of doc.edges) {
    if (e.target === id) return e.source;
  }
  return null;
}

/** 找某块的直接子 id 列表（按世界坐标 y 升序，再按 x 升序稳定排序）。 */
export function findChildIds(doc: FocusNavDoc, id: string): string[] {
  const ids: string[] = [];
  for (const e of doc.edges) {
    if (e.source === id) ids.push(e.target);
  }
  return sortNodesByY(doc, ids);
}

/** 同父的兄弟块 id 列表（含自身），按 y 升序。 */
export function findSiblingIds(doc: FocusNavDoc, id: string): string[] {
  const parent = findParentId(doc, id);
  if (parent === null) {
    // 无父：根块互为兄弟（按 y 排序）。
    const roots = doc.nodes.filter((n) => !findParentId(doc, n.id)).map((n) => n.id);
    return sortNodesByY(doc, roots);
  }
  return findChildIds(doc, parent);
}

function sortNodesByY(doc: FocusNavDoc, ids: string[]): string[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  return ids
    .map((id) => byId.get(id))
    .filter((n): n is BlockNode => !!n)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((n) => n.id);
}

/**
 * 计算导航目标块 id。返回 null 表示该方向无路可走（已在父级/无子块/已是首尾兄弟）。
 */
export function navigateFocus(
  doc: FocusNavDoc,
  currentId: string | null,
  dir: FocusNavDirection,
): string | null {
  if (dir === 'firstChild') {
    if (!currentId) return null;
    const kids = findChildIds(doc, currentId);
    return kids[0] ?? null;
  }
  if (dir === 'parent') {
    if (!currentId) return null;
    return findParentId(doc, currentId);
  }
  // prev/next sibling
  if (!currentId) {
    // 无选中：首次进入时给最靠上的块。
    const sorted = sortNodesByY(
      doc,
      doc.nodes.map((n) => n.id),
    );
    return dir === 'nextSibling' ? sorted[0] ?? null : sorted[sorted.length - 1] ?? null;
  }
  const siblings = findSiblingIds(doc, currentId);
  const idx = siblings.indexOf(currentId);
  if (idx < 0) return null;
  const next = dir === 'nextSibling' ? idx + 1 : idx - 1;
  if (next < 0 || next >= siblings.length) return null;
  return siblings[next] ?? null;
}
