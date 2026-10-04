import type { MainTree } from '@drawpaper/core';
import { enumerateSubtree } from '@drawpaper/core';

/**
 * 大纲拖拽改父子的纯逻辑（零 DOM，可单测）。
 *
 * 拖拽落点三态（按指针在目标行内的纵向位置判定）：
 * - 'before'：落在目标行上 1/3 → 成为目标的兄弟，插到目标之前；
 * - 'after' ：落在目标行下 1/3 → 成为目标的兄弟，插到目标之后；
 * - 'child' ：落在目标行中部 1/3 → 成为目标的最后一个子节点。
 */
export type DropPosition = 'before' | 'after' | 'child';

/** 解析后的重挂载目标：newParentId + 新父下的插入下标。 */
export interface ReparentTarget {
  newParentId: string | null;
  index: number;
}

/** dragId 是否在 ancestorId 的子树内（含自身）。 */
export function isInSubtree(tree: MainTree, ancestorId: string, dragId: string): boolean {
  return enumerateSubtree(tree, ancestorId).includes(dragId);
}

/**
 * 该落点是否合法：
 * - 拖到自己身上（before/after on self）→ 合法（视为原地不动，调用方可不提交）；
 * - 拖到自己后代身上（任意 position）→ 非法（会成环）；
 * - 目标不存在 → 非法。
 */
export function canReparent(
  tree: MainTree,
  dragId: string,
  targetId: string,
  position: DropPosition,
): boolean {
  if (dragId === targetId) return true;
  if (!tree.nodes[targetId]) return false;
  // 落到后代的内部或相邻位置都会成环。
  if (isInSubtree(tree, dragId, targetId)) return false;
  // child：直接成为 target 的子节点，只要 target 不是 drag 的后代即可。
  // before/after：新父 = target 的父；只要 target 不在 drag 子树内即可（上面已拦）。
  void position;
  return true;
}

/**
 * 把拖拽落点解析成 (newParentId, index)。非法落点返回 null。
 * index = 在新父 children 数组中的插入位置（剔除被拖拽节点自身后计算）。
 * newParentId 为 null = 根级（森林 roots）。
 */
export function resolveReparentTarget(
  tree: MainTree,
  dragId: string,
  targetId: string,
  position: DropPosition,
): ReparentTarget | null {
  if (dragId === targetId) return null; // 原地拖自己，不提交
  if (!tree.nodes[targetId]) return null;
  if (!canReparent(tree, dragId, targetId, position)) return null;

  if (position === 'child') {
    const parentChildren = tree.nodes[targetId]?.children ?? [];
    return { newParentId: targetId, index: parentChildren.length };
  }

  // before / after：挂到目标的父节点下
  const targetParent = tree.nodes[targetId]?.parentId ?? null;
  const siblings = (targetParent ? tree.nodes[targetParent]?.children : tree.roots) ?? [];
  // 剔除被拖拽节点自身后的兄弟序列
  const filtered = siblings.filter((id) => id !== dragId);
  const targetIdx = filtered.indexOf(targetId);
  if (targetIdx < 0) return null;
  const index = position === 'before' ? targetIdx : targetIdx + 1;
  return { newParentId: targetParent, index };
}

/**
 * 按指针在一行内的相对纵向位置（0~1）判定落点三态。
 * 上 30% = before，下 30% = after，中间 = child。
 */
export function positionFromPointerRatio(ratioY: number): DropPosition {
  if (ratioY < 0.3) return 'before';
  if (ratioY > 0.7) return 'after';
  return 'child';
}
