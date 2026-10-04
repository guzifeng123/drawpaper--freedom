import { describe, it, expect } from 'vitest';
import { A4_PORTRAIT_PX, A4_LANDSCAPE_PX, mmToPx } from '@drawpaper/core';
import { sheetSizePx, contentSizePx, pageNumberLabel } from './layout-utils';

describe('A4 常量', () => {
  it('96dpi 纵向 ≈ 794×1123，横向互换', () => {
    expect(A4_PORTRAIT_PX.width).toBeCloseTo(794, 0);
    expect(A4_PORTRAIT_PX.height).toBeCloseTo(1123, 0);
    expect(A4_LANDSCAPE_PX.width).toBeCloseTo(1123, 0);
    expect(A4_LANDSCAPE_PX.height).toBeCloseTo(794, 0);
  });

  it('sheetSizePx 按方向返回', () => {
    expect(sheetSizePx('portrait').width).toBe(A4_PORTRAIT_PX.width);
    expect(sheetSizePx('landscape').height).toBe(A4_PORTRAIT_PX.width);
  });
});

describe('contentSizePx 三档边距', () => {
  it('纵向 10/15/20mm 内容区宽高', () => {
    for (const m of [10, 15, 20] as const) {
      const c = contentSizePx('portrait', m);
      expect(c.width).toBeCloseTo(A4_PORTRAIT_PX.width - 2 * mmToPx(m), 1);
      expect(c.height).toBeCloseTo(A4_PORTRAIT_PX.height - 2 * mmToPx(m), 1);
    }
  });

  it('横向内容区宽高互换', () => {
    const c = contentSizePx('landscape', 15);
    expect(c.width).toBeCloseTo(A4_LANDSCAPE_PX.width - 2 * mmToPx(15), 1);
    expect(c.height).toBeCloseTo(A4_LANDSCAPE_PX.height - 2 * mmToPx(15), 1);
  });
});

describe('pageNumberLabel', () => {
  it('第 n / N 页', () => {
    expect(pageNumberLabel(0, 3)).toBe('第 1 / 3 页');
    expect(pageNumberLabel(2, 3)).toBe('第 3 / 3 页');
  });
});
