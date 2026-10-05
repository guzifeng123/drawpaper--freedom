/**
 * bend-active.ts —— 当前「激活弯折点」的模块级注册表（零依赖、同步）。
 *
 * 背景：弯折点锚点的 pointerdown 发生在 ParentEdge 内部，而 Delete/Backspace 的全局
 * 拦截在 useKeyboardShortcuts（window capture 阶段）。二者需要一个共同事实源：
 *   - ParentEdge 在锚点 pointerdown 时 setActive({edgeId, index})，pointerup / 离开清空；
 *   - useKeyboardShortcuts 在 Delete/Backspace 时 getActive()：
 *       · 有激活锚点 → 只删这一个点（preventDefault，拦掉删边/删块）；
 *       · 无激活锚点 → 不干预，Edge 选中走 RF 原生删边、块选中走删块。
 *
 * 用模块级单例而非 Context：跨组件通信、无需触发 React 重渲染（仅同步读写字段）。
 */

export interface ActiveBendAnchor {
  edgeId: string;
  index: number;
}

let active: ActiveBendAnchor | null = null;

/** 记录当前激活的弯折点（传 null 清空）。 */
export function setActiveBendAnchor(a: ActiveBendAnchor | null): void {
  active = a;
}

/** 读当前激活的弯折点（无则 null）。 */
export function getActiveBendAnchor(): ActiveBendAnchor | null {
  return active;
}
