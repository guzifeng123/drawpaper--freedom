// Wave1-D 画布编辑层公开出口。
import './css/editor-theme.css';

export { CanvasEditor } from './canvas/CanvasEditor';
export { EditorApiContext, useEditorApi, useEditorSnapshot } from './canvas/editor-context';
export type {
  EditorApi,
  EditorSnapshot,
  PendingConflicts,
  LayoutGhost,
  ConflictResolutionInput,
} from './editor-api';
export { createMockEditorApi, createEmptyDoc } from './mock-editor-api';
export { createBlockEditor } from './tiptap/createBlockEditor';
export { StaticHtml, tiptapJsonToHtml } from './tiptap/static';

// Wave3-I：纯函数工具（图遍历 / 标签筛选 / 手势状态机）
export {
  collectConnectedSet,
  collectFocusSet,
  collectEdgeChain,
  applyManualFixed,
} from './lib/graph-trace';
export { nodeMatchesFilter, collectFilteredNodes, EMPTY_TAG_FILTER } from './lib/filter-match';
export type { TagFilter, TagFilterMode } from './lib/filter-match';
export {
  initialGestureState,
  reduceGesture,
  DEFAULT_GESTURE_CONFIG,
} from './state/gesture';
export type { GestureState, GestureEvent, GestureIntent, GestureConfig } from './state/gesture';
export { renderEquationAsync, renderEquation, ensureKatex, stripDollars } from './tiptap/katex-html';
