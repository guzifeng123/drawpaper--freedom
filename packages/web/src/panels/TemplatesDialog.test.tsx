import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { TemplatesDialog } from './TemplatesDialog';
import { createMockPanelsApi } from './create-mock-panels-api';

describe('TemplatesDialog', () => {
  it('渲染 6 份模板卡片', () => {
    render(<TemplatesDialog open onOpenChange={() => undefined} api={createMockPanelsApi()} />);
    for (const name of ['读书笔记', '会议纪要', '课程大纲', '头脑风暴', '知识体系', '项目拆解']) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it('点卡片 → createDocFromTemplate(templateId)', () => {
    const api = createMockPanelsApi();
    const create = vi.spyOn(api, 'createDocFromTemplate');
    render(<TemplatesDialog open onOpenChange={() => undefined} api={api} />);
    fireEvent.click(screen.getByText('读书笔记'));
    expect(create).toHaveBeenCalledWith('reading');
  });
});
