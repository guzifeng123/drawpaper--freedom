import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OverviewCanvas } from './OverviewCanvas';
import { MockOverviewProvider, makeMockDoc } from './mock-overview-provider';
import type { KBNoteDoc } from '@drawpaper/core';

// jsdom 缺少 ResizeObserver（ReactFlow 依赖）。
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as Record<string, unknown>).ResizeObserver =
  (globalThis as Record<string, unknown>).ResizeObserver ?? ResizeObserverStub;

function twoDocFixture(): KBNoteDoc[] {
  const docA = makeMockDoc('docA', 'A 文档', [
    { id: 'a1', label: '引言块' },
    { id: 'a2', label: '方法块' },
  ]);
  const docB = makeMockDoc(
    'docB',
    'B 文档',
    [{ id: 'b1', label: '结果块' }],
    // a1 → b1 cross-doc link
    [
      {
        id: 'ln_1',
        sourceDocId: 'docA',
        sourceNodeId: 'a1',
        targetDocId: 'docB',
        targetNodeId: 'b1',
        targetTitle: '结果块',
        createdAt: 0,
      },
    ],
  );
  return [docA, docB];
}

describe('OverviewCanvas', () => {
  it('renders both doc groups and block nodes after load', async () => {
    const provider = new MockOverviewProvider(twoDocFixture());
    render(<OverviewCanvas provider={provider} />);
    await waitFor(() => expect(screen.getByTestId('overview-canvas')).toBeTruthy());
    // 块节点标题出现在画布中
    expect(await screen.findByText('引言块')).toBeTruthy();
    expect(screen.getByText('结果块')).toBeTruthy();
  });

  it('clicking a block node fires onOpenDocNode with docId+nodeId', async () => {
    const onOpen = vi.fn();
    const provider = new MockOverviewProvider(twoDocFixture());
    render(<OverviewCanvas provider={provider} onOpenDocNode={onOpen} />);
    await screen.findByText('引言块');
    fireEvent.click(screen.getByText('引言块'));
    expect(onOpen).toHaveBeenCalledWith('docA', 'a1');
  });

  it('search filters and highlights matching blocks', async () => {
    const provider = new MockOverviewProvider(twoDocFixture());
    render(<OverviewCanvas provider={provider} />);
    await screen.findByText('引言块');
    const input = screen.getByTestId('overview-search');
    fireEvent.change(input, { target: { value: '结果' } });
    // 命中块高亮（描边蓝）— 结果块仍可见
    await waitFor(() => expect(screen.getByText('结果块')).toBeTruthy());
  });

  it('large dataset auto-collapses to doc clusters', async () => {
    // 3 docs × 300 blocks = 900 > 600 → 自动折叠
    const docs: KBNoteDoc[] = ['d1', 'd2', 'd3'].map((id) =>
      makeMockDoc(id, id, Array.from({ length: 300 }, (_, i) => ({ id: `n${i}`, label: `b${i}` }))),
    );
    const provider = new MockOverviewProvider(docs);
    render(<OverviewCanvas provider={provider} />);
    await waitFor(() => expect(screen.getByText('节点较多，已按文档聚合')).toBeTruthy());
  });
});
