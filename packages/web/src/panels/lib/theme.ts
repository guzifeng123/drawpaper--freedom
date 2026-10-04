import { create } from 'zustand';

/**
 * 主题 store（Wave3-H P1）。
 *
 * - 三态：light / dark / system（跟随系统）；
 * - 选择持久化 localStorage（key: 'drawpaper-theme'）；
 * - 应用方式：<html> 根节点切 .dark class（tailwind darkMode:'class'）；
 * - mode=system 时监听 prefers-color-scheme 变化实时切换；
 * - 首屏无闪烁：index.html 内联脚本在 React 挂载前先读 localStorage 加 .dark；
 *   本模块在首次被 import 时（TopToolbar 挂载）再幂等 apply 一次。
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'drawpaper-theme';

function readStoredMode(): ThemeMode {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_STORAGE_KEY) : null;
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* 隐私模式 / 禁用存储时静默回退 */
  }
  return 'system';
}

export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? systemTheme() : mode;
}

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  /** 幂等：把当前 mode 应用到 <html> class + 持久化。 */
  apply: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: readStoredMode(),
  resolved: 'light',
  setMode: (mode) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      /* 忽略持久化失败 */
    }
    set({ mode });
    get().apply();
  },
  apply: () => {
    const resolved = resolveTheme(get().mode);
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', resolved === 'dark');
    }
    set({ resolved });
  },
}));

// system 模式下跟随系统变化（只挂一次监听）。
if (typeof window !== 'undefined' && window.matchMedia) {
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      const s = useThemeStore.getState();
      if (s.mode === 'system') s.apply();
    });
}

// 模块首次 import 即幂等应用（TopToolbar 挂载前完成首帧同步）。
if (typeof document !== 'undefined') {
  useThemeStore.getState().apply();
}
