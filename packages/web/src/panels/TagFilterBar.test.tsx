import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { TagFilterBar } from './TagFilterBar';
import { createMockPanelsApi } from './create-mock-panels-api';

describe('TagFilterBar', () => {
  it('标签为 0 且无筛选时不渲染', () => {
    const api = createMockPanelsApi();
    api.tags.length = 0;
    const { container } = render(<TagFilterBar api={api} />);
    expect(container.firstChild).toBeNull();
  });

  it('点标签 chip → setTagFilter 写入选中 id', () => {
    const api = createMockPanelsApi();
    const set = vi.spyOn(api, 'setTagFilter');
    render(<TagFilterBar api={api} />);
    fireEvent.click(screen.getByText('灵感'));
    expect(set).toHaveBeenCalledWith({ tagIds: ['t_1'] });
  });

  it('有筛选时出现清除按钮 → clearTagFilter', () => {
    const api = createMockPanelsApi();
    api.setTagFilter({ tagIds: ['t_1'] });
    const clear = vi.spyOn(api, 'clearTagFilter');
    render(<TagFilterBar api={api} />);
    fireEvent.click(screen.getByText('清除'));
    expect(clear).toHaveBeenCalled();
  });

  it('切换 any/all 语义', () => {
    const api = createMockPanelsApi();
    const set = vi.spyOn(api, 'setTagFilter');
    render(<TagFilterBar api={api} />);
    fireEvent.click(screen.getByText('任一'));
    expect(set).toHaveBeenCalledWith({ match: 'all' });
  });
});
