import { describe, it, expect, beforeEach, vi } from 'vitest';

// jsdom 没有 matchMedia，先打桩（在 import theme 之前）。
beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('dark'),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('theme store', async () => {
  it('切换 light/dark 同步 .dark class 并持久化 localStorage', async () => {
    const { useThemeStore, THEME_STORAGE_KEY } = await import('./theme');
    useThemeStore.getState().setMode('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    useThemeStore.getState().setMode('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('system 模式下 resolved 跟随系统', async () => {
    const { useThemeStore, resolveTheme } = await import('./theme');
    expect(resolveTheme('system')).toBe('dark'); // 桩里 dark 匹配
    useThemeStore.getState().setMode('system');
    expect(useThemeStore.getState().resolved).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('首屏从 localStorage 恢复 mode', async () => {
    localStorage.setItem('drawpaper-theme', 'dark');
    vi.resetModules();
    const mod = await import('./theme');
    mod.useThemeStore.getState().apply();
    expect(mod.useThemeStore.getState().mode).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
