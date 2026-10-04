import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { TagManagerDialog } from './TagManagerDialog';
import { createMockPanelsApi } from './create-mock-panels-api';

function open(api = createMockPanelsApi()) {
  render(<TagManagerDialog open onOpenChange={() => undefined} api={api} />);
  return api;
}

describe('TagManagerDialog', () => {
  it('列出已有标签', () => {
    open();
    expect(screen.getByText('灵感')).toBeTruthy();
    expect(screen.getByText('待办')).toBeTruthy();
  });

  it('新建标签：输入名字点新建 → createTag', () => {
    const api = open();
    const create = vi.spyOn(api, 'createTag');
    fireEvent.change(screen.getByPlaceholderText('新标签名字…'), { target: { value: '读书' } });
    fireEvent.click(screen.getByRole('button', { name: /新建/ }));
    expect(create).toHaveBeenCalledWith('读书', expect.any(String));
  });

  it('删除标签先走确认框，确认后 deleteTag', () => {
    const api = open();
    const del = vi.spyOn(api, 'deleteTag');
    fireEvent.click(screen.getAllByTitle('删除标签')[0]!);
    expect(screen.getByText('删除标签？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(del).toHaveBeenCalledWith('t_1');
  });

  it('迷你色板点色 → changeTagColor', () => {
    const api = open();
    const recolor = vi.spyOn(api, 'changeTagColor');
    fireEvent.click(screen.getAllByTitle('改成 #22c55e')[0]!);
    expect(recolor).toHaveBeenCalledWith('t_1', '#22c55e');
  });
});
