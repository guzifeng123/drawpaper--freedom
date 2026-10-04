import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { SnapshotsDialog } from './SnapshotsDialog';
import { createMockPanelsApi } from './create-mock-panels-api';

function open(api = createMockPanelsApi()) {
  render(<SnapshotsDialog open onOpenChange={() => undefined} api={api} />);
  return api;
}

describe('SnapshotsDialog', () => {
  it('列出快照（label + 时间标题）', () => {
    open();
    expect(screen.getByText('初稿')).toBeTruthy();
    expect(screen.getByText(/未命名画布/)).toBeTruthy();
  });

  it('拍快照 → takeSnapshot(label)', () => {
    const api = open();
    const take = vi.spyOn(api, 'takeSnapshot');
    fireEvent.change(screen.getByPlaceholderText('给这次快照起个名字（可选）…'), {
      target: { value: '演示' },
    });
    fireEvent.click(screen.getByRole('button', { name: /拍快照/ }));
    expect(take).toHaveBeenCalledWith('演示');
  });

  it('恢复走确认框 → restoreSnapshot', () => {
    const api = open();
    const restore = vi.spyOn(api, 'restoreSnapshot');
    fireEvent.click(screen.getAllByTitle('恢复到此快照')[0]!);
    expect(screen.getByText('恢复到此快照？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    expect(restore).toHaveBeenCalledWith('snap_1');
  });

  it('删除单条快照 → deleteSnapshot', () => {
    const api = open();
    const del = vi.spyOn(api, 'deleteSnapshot');
    fireEvent.click(screen.getAllByTitle('删除快照')[0]!);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(del).toHaveBeenCalledWith('snap_1');
  });
});
