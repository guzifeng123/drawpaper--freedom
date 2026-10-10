import { create } from 'zustand';

/**
 * 外壳级 UI 状态（Wave24 UI 溢出修复）：
 * 文档列表面板（DocsListPanel）的展开/收起会改变左下角画布区域的可用宽度，
 * React Flow `<Controls>` 需要据此避让，避免按钮压在文档列表/轨道上。
 */
type UiShellState = {
  docsCollapsed: boolean;
  setDocsCollapsed: (collapsed: boolean) => void;
};

export const useUiShell = create<UiShellState>((set) => ({
  docsCollapsed: typeof window !== 'undefined' ? window.innerWidth < 640 : false,
  setDocsCollapsed: (docsCollapsed) => set({ docsCollapsed }),
}));
