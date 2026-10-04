import { createContext, useContext, useSyncExternalStore } from 'react';
import type { EditorApi, EditorSnapshot } from '../editor-api';

/**
 * EditorProvider：把 EditorApi 注入组件树。
 * CanvasEditor 挂载时传入；节点/边/弹窗全部 useEditorApi() 取用。
 *
 * 订阅粒度：用 useSyncExternalStore + 原始值 selector，
 * 使 500 个节点只在自己关心的切片变化时重渲染（视口平移不触发节点重渲染）。
 */
export const EditorApiContext = createContext<EditorApi | null>(null);

export function useEditorApi(): EditorApi {
  const api = useContext(EditorApiContext);
  if (!api) throw new Error('useEditorApi must be used inside <EditorApiContext.Provider>');
  return api;
}

/** 整份快照（画布级组件用）。 */
export function useEditorSnapshot(): EditorSnapshot {
  const api = useEditorApi();
  return useSyncExternalStore(api.subscribe, api.getState, api.getState);
}

/** 仅订阅「当前编辑中的节点 id」（原始值，变化才重渲染）。 */
export function useEditingNodeId(): string | null {
  const api = useEditorApi();
  return useSyncExternalStore(
    api.subscribe,
    () => api.getState().editingNodeId,
    () => api.getState().editingNodeId,
  );
}

/** 仅订阅某节点的直接子节点数（折叠角标用）。 */
export function useChildCount(blockId: string): number {
  const api = useEditorApi();
  return useSyncExternalStore(
    api.subscribe,
    () => api.getState().doc.edges.reduce((n, e) => (e.source === blockId ? n + 1 : n), 0),
    () => api.getState().doc.edges.reduce((n, e) => (e.source === blockId ? n + 1 : n), 0),
  );
}

/** 仅订阅某节点是否处于搜索高亮。 */
export function useSearchHighlight(blockId: string): boolean {
  const api = useEditorApi();
  return useSyncExternalStore(
    api.subscribe,
    () => api.getState().searchHighlight.has(blockId),
    () => api.getState().searchHighlight.has(blockId),
  );
}
