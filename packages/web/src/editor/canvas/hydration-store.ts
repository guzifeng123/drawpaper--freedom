import { useSyncExternalStore } from 'react';

/**
 * hydration-store —— 「已水合（完整渲染）」节点 id 的细粒度外部状态。
 *
 * 大文档首 commit 时 ReactFlow 会把全部节点一次性挂载（视口尺寸未测得前不裁剪），
 * 每个 BlockShell 立即跑 generateHTML = 十几秒长任务。这里维护一个 hydrated id 集合：
 *  - BlockShell 未在集合内 → 渲染轻量占位壳（纯文本摘要，零 generateHTML / 零 Tiptap）；
 *  - 在集合内 → 渲染完整静态 HTML（StaticHtml）。
 *
 * 纯 UI 态，放在 web（core 零 DOM/React）。调度计划（哪些 id 该升级/降级）由 core
 * 的 planHydration 纯函数算，本 store 只负责「应用增量 + 细粒度订阅」。
 */

let hydrated = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** 切文档时重置：所有块回到占位壳，由调度器按新视口重新水合。 */
export function resetHydrated(): void {
  if (hydrated.size === 0) return;
  hydrated = new Set();
  emit();
}

/**
 * 应用一次升级/降级增量。只在集合真正变化时才触发通知（避免无意义重渲染）。
 * 返回是否发生了变化。
 */
export function applyHydrationDelta(addIds: readonly string[], removeIds: readonly string[]): boolean {
  if (addIds.length === 0 && removeIds.length === 0) return false;
  let next: Set<string> | null = null;
  for (const id of addIds) {
    if (!hydrated.has(id)) {
      (next ??= new Set(hydrated)).add(id);
    }
  }
  for (const id of removeIds) {
    if (hydrated.has(id)) {
      (next ??= new Set(hydrated)).delete(id);
    }
  }
  if (!next) return false;
  hydrated = next;
  emit();
  return true;
}

/** 当前已水合 id 快照（调度器读它算 plan，不订阅）。 */
export function getHydratedSnapshot(): ReadonlySet<string> {
  return hydrated;
}

/** BlockShell 订阅：仅当自己的水合态翻转时重渲染。 */
export function useIsHydrated(id: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => hydrated.has(id),
    () => hydrated.has(id),
  );
}
