import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { TrashDialog } from './TrashDialog';
import { createMockPanelsApi } from './create-mock-panels-api';

function open() {
  const api = createMockPanelsApi();
  // 直接塞一条回收站记录
  (api.trash as unknown as { id: string; title: string; deletedAt: number; kind: 'doc' | 'snapshot' }[]).push({
    id: 'tr_1',
    title: '旧文档',
    deletedAt: Date.now() - 1000 * 60,
    kind: 'doc',
  });
  render(<TrashDialog open onOpenChange={() => undefined} api={api} />);
  return api;
}

describe('TrashDialog', () => {
  it('回收站为空时显示空态', () => {
    const api = createMockPanelsApi();
    render(<TrashDialog open onOpenChange={() => undefined} api={api} />);
    expect(screen.getByText('回收站是空的')).toBeTruthy();
  });

  it('列出条目并支持恢复', () => {
    const api = open();
    expect(screen.getByText('旧文档')).toBeTruthy();
    const restore = vi.spyOn(api, 'restoreFromTrash');
    fireEvent.click(screen.getByRole('button', { name: /恢复/ }));
    expect(restore).toHaveBeenCalledWith('tr_1');
  });

  it('彻底删除走确认框', () => {
    const api = open();
    const purge = vi.spyOn(api, 'purgeFromTrash');
    fireEvent.click(screen.getByTitle('彻底删除'));
    expect(screen.getByText('彻底删除？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }));
    expect(purge).toHaveBeenCalledWith('tr_1');
  });

  it('清空回收站走确认框 → emptyTrash', () => {
    const api = open();
    const empty = vi.spyOn(api, 'emptyTrash');
    fireEvent.click(screen.getByRole('button', { name: /清空回收站/ }));
    expect(screen.getByText('清空回收站？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(empty).toHaveBeenCalled();
  });
});
