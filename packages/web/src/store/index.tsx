import { useStore } from 'zustand';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import type { DocMeta, EditorActions, EditorState } from '@drawpaper/core';
import { editorStore } from './editor-store';

/**
 * React 接线：基于单例 vanilla store 的 hooks。
 * Wave2/UI agent 只从这里 import，不直接碰 core。
 */

/** 通用选择器 hook（可选 equalityFn）。 */
export function useEditorStore<T>(
  selector: (state: EditorState) => T,
  equalityFn?: (a: T, b: T) => boolean,
): T {
  return useStoreWithEqualityFn(editorStore, selector, equalityFn);
}

/** 稳定的 actions 句柄（action 引用在 store 生命周期内不变，不触发重渲染）。 */
export function useActions(): EditorActions {
  return useStoreWithEqualityFn(
    editorStore,
    (s) => s,
    (a, b) => a.newDoc === b.newDoc && a.undo === b.undo,
  );
}

/** 保存状态（自动保存提示用）。 */
export function useSaveStatus(): { saveState: EditorState['saveState']; savedAt: number | null } {
  return useStore(editorStore, (s) => ({ saveState: s.saveState, savedAt: s.savedAt }));
}

/** 文档列表。 */
export function useDocs(): DocMeta[] {
  return useStore(editorStore, (s) => s.docs);
}

export { editorStore } from './editor-store';
export type { EditorState, EditorActions } from '@drawpaper/core';
