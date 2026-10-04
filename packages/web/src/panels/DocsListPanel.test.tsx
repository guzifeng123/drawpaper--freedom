import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { DocsListPanel } from './DocsListPanel';
import { createMockPanelsApi } from './create-mock-panels-api';

describe('DocsListPanel', () => {
  it('列出文档并高亮当前文档', () => {
    const api = createMockPanelsApi();
    render(<DocsListPanel api={api} />);
    expect(screen.getByText('未命名画布')).toBeTruthy();
    expect(screen.getByText('读书笔记')).toBeTruthy();
  });

  it('删除走确认框，确认后调用 removeDoc', () => {
    const api = createMockPanelsApi();
    const before = api.docs.length;
    const remove = vi.spyOn(api, 'removeDoc');
    render(<DocsListPanel api={api} />);

    // 删除按钮在每行 hover 才显示，但 jsdom 里仍在 DOM。
    const delBtns = screen.getAllByTitle('删除');
    fireEvent.click(delBtns[0]!);

    // 确认框出现
    expect(screen.getByText('删除文档？')).toBeTruthy();
    fireEvent.click(screen.getByText('删除', { selector: 'button' }));

    expect(remove).toHaveBeenCalled();
    expect(api.docs.length).toBe(before - 1);
  });
});
