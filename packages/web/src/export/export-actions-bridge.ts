import type { ExportDialogActions } from './ExportDialog';

/**
 * Wave12：原生菜单 → 导出动作桥。
 *
 * `useExportModel` 返回的五个动作（print/png/pdf/svg/markdown）闭包在 React
 * hook 里，原生菜单事件发生在 React 之外（Rust emit → 全局监听），拿不到 hook
 * 实例。这里放一个最小注册表：App.tsx 在 hook 算出 actions 后注册一次，
 * desktop-bridge 的菜单路由直接调 `runExportAction(id)`。浏览器环境没注册
 * 时 no-op（actions 为 null）。
 */

export type ExportActionId = 'print' | 'png' | 'pdf' | 'svg' | 'md';

let actions: ExportDialogActions | null = null;

export function registerExportActions(a: ExportDialogActions): void {
  actions = a;
}

export function runExportAction(id: ExportActionId): void {
  if (!actions) return;
  switch (id) {
    case 'print':
      actions.onPrint();
      break;
    case 'png':
      actions.onExportPng();
      break;
    case 'pdf':
      actions.onExportPdf();
      break;
    case 'svg':
      actions.onExportSvg();
      break;
    case 'md':
      actions.onExportMarkdown();
      break;
  }
}
