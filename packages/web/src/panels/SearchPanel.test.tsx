import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { SearchPanel } from './SearchPanel';
import { createMockPanelsApi } from './create-mock-panels-api';

function setup() {
  const api = createMockPanelsApi();
  api.openSearch();
  api.setSearchQuery('横向');
  api.searchResults = [
    { nodeId: 'n1', nodeType: 'heading', snippet: '思维导图 横向布局', matchStart: 5, matchLength: 2, score: 1 },
    { nodeId: 'n2', nodeType: 'text', snippet: '另一个块', matchStart: 0, matchLength: 3, score: 0.5 },
  ];
  const flyTo = vi.spyOn(api, 'flyToNode');
  render(<SearchPanel api={api} />);
  return { api, flyTo };
}

describe('SearchPanel', () => {
  it('渲染结果列表并高亮命中词', () => {
    setup();
    expect(screen.getByText('横向')).toBeTruthy();
    expect(document.querySelectorAll('mark').length).toBeGreaterThan(0);
  });

  it('Enter 触发 flyToNode', () => {
    const { api, flyTo } = setup();
    const input = screen.getByPlaceholderText(/搜索块内文字/);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // activeSearchIndex = 0，selectSearchResult 会调 flyToNode
    expect(api.activeSearchIndex).toBe(0);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(flyTo).toHaveBeenCalledWith('n1');
  });

  it('Esc 关闭', () => {
    const { api } = setup();
    const input = screen.getByPlaceholderText(/搜索块内文字/);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(api.searchOpen).toBe(false);
  });
});
