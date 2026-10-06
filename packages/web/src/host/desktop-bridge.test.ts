import { describe, expect, it } from 'vitest';

import { computeWindowTitle, initDesktopBridge, isTauriRuntime } from './desktop-bridge';

/**
 * Wave12 桌面桥单测：
 *  - 纯函数 computeWindowTitle 三种格式（脏/干净/无文档）；
 *  - 浏览器环境（无 __TAURI__）initDesktopBridge 必须是 no-op：不抛错、
 *    返回一个可调用的清理函数、不尝试 invoke 任何 Rust 命令。
 */
describe('computeWindowTitle 窗口标题三种格式', () => {
  it('脏文档：● 前缀 + 文档名 + 应用名', () => {
    expect(computeWindowTitle('季度计划', true)).toBe('● 季度计划 — drawpaper');
  });
  it('干净文档：无圆点', () => {
    expect(computeWindowTitle('季度计划', false)).toBe('季度计划 — drawpaper');
  });
  it('无文档/空标题：仅应用名', () => {
    expect(computeWindowTitle(null, false)).toBe('drawpaper');
    expect(computeWindowTitle(undefined, true)).toBe('drawpaper');
    expect(computeWindowTitle('', false)).toBe('drawpaper');
  });
});

describe('浏览器环境桌面桥 no-op', () => {
  it('非 Tauri 运行时：isTauriRuntime() 为 false', () => {
    expect(isTauriRuntime()).toBe(false);
  });

  it('initDesktopBridge 不抛错、返回可调用清理函数、不触碰 __TAURI__', () => {
    // jsdom 环境 window 上没有 __TAURI__ → 直接短路返回 no-op。
    const dispose = initDesktopBridge();
    expect(typeof dispose).toBe('function');
    expect(() => dispose()).not.toThrow();
  });
});
