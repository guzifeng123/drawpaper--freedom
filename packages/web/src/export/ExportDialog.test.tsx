import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { ExportDialog, type ExportDialogActions } from './ExportDialog';
import { createMockPanelsApi } from '@/panels/create-mock-panels-api';

/** 构造一个可控 api：默认打开导出弹窗。 */
function setup() {
  const api = createMockPanelsApi();
  // 直接把弹窗打开（mock 的内部状态）
  (api as unknown as { closeExport(): void; openExport(): void }).openExport();
  const actions: ExportDialogActions = {
    onPrint: vi.fn(),
    onExportPng: vi.fn(),
    onExportPdf: vi.fn(),
    onExportSvg: vi.fn(),
    onExportMarkdown: vi.fn(),
  };
  render(<ExportDialog api={api} actions={actions} />);
  return { api, actions };
}

describe('ExportDialog', () => {
  it('默认纵向 / tiles 模式，文件名实时预览', () => {
    setup();
    expect(screen.getByText('A4 纵向')).toBeTruthy();
    expect(screen.getByText(/_纵向\.pdf/)).toBeTruthy();
  });

  it('切换横向 → 文件名变横向', () => {
    const { api } = setup();
    fireEvent.click(screen.getByText('A4 横向'));
    expect(api.page.orientation).toBe('landscape');
    expect(screen.getByText(/_横向\.pdf/)).toBeTruthy();
  });

  it('切换排版模式 tabs → setPageSettings payload', () => {
    const { api } = setup();
    const fit = screen.getByText('Fit 一页');
    fireEvent.focus(fit);
    fireEvent.click(fit);
    expect(api.page.mode).toBe('fit');
    const flow = screen.getByText('Flow 重排');
    fireEvent.focus(flow);
    fireEvent.click(flow);
    expect(api.page.mode).toBe('flow');
  });

  it('切换边距 / 黑白 / 页眉开关写回 page', () => {
    const { api } = setup();
    fireEvent.click(screen.getByText('20mm'));
    expect(api.page.marginMm).toBe(20);
    // 彩色/黑白 switch
    const grayLabel = screen.getByText('彩色 / 黑白');
    const sw = grayLabel.parentElement!.querySelector('button[role="switch"]')!;
    fireEvent.click(sw);
    expect(api.page.colorMode).toBe('gray');
  });

  it('操作按钮触发对应回调', () => {
    const { actions } = setup();
    fireEvent.click(screen.getByText('打印 / 另存 PDF'));
    expect(actions.onPrint).toHaveBeenCalled();
    fireEvent.click(screen.getByText('导出高清 PNG'));
    expect(actions.onExportPng).toHaveBeenCalled();
    fireEvent.click(screen.getByText('直接下载 PDF'));
    expect(actions.onExportPdf).toHaveBeenCalled();
  });
});
