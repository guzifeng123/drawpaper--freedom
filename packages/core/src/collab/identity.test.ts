import { describe, it, expect } from 'vitest';
import {
  generateClientId,
  pickTabColor,
  createTabIdentity,
  TAB_COLOR_PALETTE,
  DEFAULT_TAB_NAME,
} from './identity.js';

describe('标签身份', () => {
  it('generateClientId 带前缀且唯一', () => {
    const a = generateClientId();
    const b = generateClientId();
    expect(a).toMatch(/^c_/);
    expect(a).not.toBe(b);
  });

  it('pickTabColor 确定性（seed 取模调色板）', () => {
    expect(pickTabColor(0)).toBe(TAB_COLOR_PALETTE[0]);
    expect(pickTabColor(TAB_COLOR_PALETTE.length)).toBe(TAB_COLOR_PALETTE[0]);
    expect(pickTabColor(-3)).toBe(TAB_COLOR_PALETTE[Math.abs(-3) % TAB_COLOR_PALETTE.length]);
  });

  it('createTabIdentity 缺省名/自定义名', () => {
    const t = createTabIdentity();
    expect(t.name).toBe(DEFAULT_TAB_NAME);
    expect(TAB_COLOR_PALETTE).toContain(t.color);
    const t2 = createTabIdentity('我的窗口', { color: '#123456' });
    expect(t2.name).toBe('我的窗口');
    expect(t2.color).toBe('#123456');
  });
});
