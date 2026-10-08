import { create } from 'zustand';

/**
 * Wave23 纯键盘跨块连线 —— 目标块选择器的开关状态（模块级小 store）。
 *
 * 与 toast 同构：useKeyboardShortcuts（window keydown）在按 `c` 时 openPicker(sourceId)，
 * ConnectTargetPicker 组件订阅本 store 决定是否渲染；确认/取消/点击外部时 closePicker。
 *
 * 非 React 侧（全局快捷键）用 isConnectPickerOpen() 同步读取，以便在选择器打开期间
 * 让路（不再建子块 / 挪块 / 清选择）。
 */
interface ConnectPickerStore {
  open: boolean;
  sourceId: string | null;
  openPicker: (sourceId: string) => void;
  closePicker: () => void;
}

export const useConnectPickerStore = create<ConnectPickerStore>((set) => ({
  open: false,
  sourceId: null,
  openPicker: (sourceId) => set({ open: true, sourceId }),
  closePicker: () => set({ open: false, sourceId: null }),
}));

/** 全局快捷键同步读取：选择器是否打开。 */
export function isConnectPickerOpen(): boolean {
  return useConnectPickerStore.getState().open;
}
