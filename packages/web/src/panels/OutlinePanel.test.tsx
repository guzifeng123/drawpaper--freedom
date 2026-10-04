import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { OutlinePanel } from './OutlinePanel';
import { createMockPanelsApi } from './create-mock-panels-api';
import type { PanelsApi } from './panels-api';

function makeApi(): PanelsApi {
  const api = createMockPanelsApi();
  // 追加一个游离块（无父子边）验证「未分组」分区
  const doc = api.doc!;
  doc.nodes.push({
    id: 'n_orphan',
    type: 'note',
    x: 500,
    y: 500,
    width: 200,
    height: 80,
    content: {
      format: 'tiptap-json',
      data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '漂浮的便签' }] }] },
    },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
  });
  return api;
}

describe('OutlinePanel', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('由父子边渲染树，并把游离块归入未分组', () => {
    const api = makeApi();
    render(<OutlinePanel api={api} />);
    expect(screen.getByText('示例子块：在这里记录你的想法。')).toBeTruthy();
    expect(screen.getByText(/未分组/)).toBeTruthy();
    expect(screen.getByText('漂浮的便签')).toBeTruthy();
  });

  it('点击条目 → flyToNode 聚焦', () => {
    const api = makeApi();
    const fly = vi.spyOn(api, 'flyToNode');
    render(<OutlinePanel api={api} />);
    fireEvent.click(screen.getByText('示例子块：在这里记录你的想法。'));
    expect(fly).toHaveBeenCalledWith('n_child');
  });

  it('点折叠箭头 → toggleCollapseNode', () => {
    const api = makeApi();
    const tog = vi.spyOn(api, 'toggleCollapseNode');
    render(<OutlinePanel api={api} />);
    fireEvent.click(screen.getByLabelText('折叠分支'));
    expect(tog).toHaveBeenCalledWith('n_root');
  });

  it('搜索过滤：不匹配的行隐藏', () => {
    const api = makeApi();
    render(<OutlinePanel api={api} />);
    const input = screen.getByPlaceholderText('过滤…');
    fireEvent.change(input, { target: { value: '漂浮' } });
    expect(screen.queryByText('示例子块：在这里记录你的想法。')).toBeNull();
    expect(screen.getByText('漂浮的便签')).toBeTruthy();
  });

  it('内联新建根级块：展开输入后 Enter → addChildBlock(null)', () => {
    const api = makeApi();
    const add = vi.spyOn(api, 'addChildBlock');
    render(<OutlinePanel api={api} />);
    fireEvent.click(screen.getByText('新建根级块'));
    const input = screen.getByPlaceholderText('输入块内容，Enter 确认…');
    fireEvent.change(input, { target: { value: '新块内容' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(add).toHaveBeenCalledWith(null, '新块内容');
  });
});
