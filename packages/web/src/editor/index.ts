// Wave1-D 画布编辑层公开出口。
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
