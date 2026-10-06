/**
 * Wave14：原生「视图」菜单 → React Flow 画布动作的最小事件转发总线。
 *
 * desktop-bridge 是非 React 模块，拿不到 `useReactFlow()` 的 `rf` 句柄；画布
 * CanvasInner 挂载后把 `rf.fitView / rf.zoomIn / rf.zoomOut` 注册进来，菜单事件
 * 经此转发。**不新写任何缩放算法**——复用 React Flow 内建方法，与画布顶部
 * 工具栏按钮、Ctrl+0/Ctrl+=/Ctrl+- 快捷键走的是同一个入口。
 *
 * 浏览器环境（PWA / E2E）：CanvasInner 仍会注册 handler，但桌面桥 routeMenu 只在
 * Tauri 运行时触发，所以浏览器永远不会调用 requestViewAction；即便误调，无注册者
 * 时也是静默 no-op，绝不报错。
 */
export type ViewAction = 'fit' | 'zoom-in' | 'zoom-out';

type ViewActionHandler = (action: ViewAction) => void;

let handler: ViewActionHandler | null = null;

/** CanvasInner 挂载时注册真实 rf 动作；卸载时传 null 注销。 */
export function registerViewActionHandler(h: ViewActionHandler | null): void {
  handler = h;
}

/** desktop-bridge 菜单转发：无注册者（浏览器/未挂载）时静默 no-op。 */
export function requestViewAction(action: ViewAction): void {
  handler?.(action);
}
