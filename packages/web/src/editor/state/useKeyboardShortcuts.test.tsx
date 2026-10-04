import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { createElement } from 'react';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { createMockEditorApi } from '../mock-editor-api';

describe('快捷键 + 中文输入法', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('Tab 建子块', () => {
    const api = createMockEditorApi();
    const parent = api.addNode('text', 0, 0);
    api.setSelection([parent]);
    const spy = vi.spyOn(api, 'tabAddChild');
    render(
      createElement(ReactFlowProvider, null, createElement(() => {
        useKeyboardShortcuts(api);
        return null;
      })),
    );
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('composition 期间 Tab 被屏蔽', () => {
    const api = createMockEditorApi();
    const parent = api.addNode('text', 0, 0);
    api.setSelection([parent]);
    const spy = vi.spyOn(api, 'tabAddChild');
    render(
      createElement(ReactFlowProvider, null, createElement(() => {
        useKeyboardShortcuts(api);
        return null;
      })),
    );
    window.dispatchEvent(new CompositionEvent('compositionstart'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(spy).not.toHaveBeenCalled();
    window.dispatchEvent(new CompositionEvent('compositionend'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('编辑中 Tab 不触发画布建块', () => {
    const api = createMockEditorApi();
    const parent = api.addNode('text', 0, 0);
    api.setSelection([parent]);
    api.setEditingNode(parent);
    const spy = vi.spyOn(api, 'tabAddChild');
    render(
      createElement(ReactFlowProvider, null, createElement(() => {
        useKeyboardShortcuts(api);
        return null;
      })),
    );
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(spy).not.toHaveBeenCalled();
  });
});
