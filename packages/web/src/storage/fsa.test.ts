import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActiveFileManager,
  estimateStorageQuota,
  isFsaSupported,
  isQuotaError,
  openWithFsa,
  saveWithFsa,
  setStorageQuotaWarningHook,
} from './fsa';

/**
 * Wave7 robustness：FSA 无 File System Access API（Safari/Firefox）兜底 +
 * QuotaExceededError 提示单测。jsdom 无 showSaveFilePicker，正好模拟不支持环境。
 */

function setWindowPicker(impl: { open?: unknown; save?: unknown }) {
  const w = window as unknown as Record<string, unknown>;
  if (impl.open === undefined) delete w.showOpenFilePicker;
  else w.showOpenFilePicker = impl.open;
  if (impl.save === undefined) delete w.showSaveFilePicker;
  else w.showSaveFilePicker = impl.save;
}

afterEach(() => {
  setWindowPicker({ open: undefined, save: undefined });
  setStorageQuotaWarningHook(() => {});
});

describe('FSA 能力检测（jsdom = 不支持，模拟 Safari/Firefox）', () => {
  it('isFsaSupported() === false 时一次性 API 返回 null/false（host 走 input/anchor 兜底）', async () => {
    setWindowPicker({ open: undefined, save: undefined });
    expect(isFsaSupported()).toBe(false);
    expect(await openWithFsa()).toBeNull();
    expect(await saveWithFsa('x.kbnote', '{}')).toBe(false);
  });
});

describe('isQuotaError 识别', () => {
  it('识别 DOMException name 与常见 message', () => {
    expect(isQuotaError(new DOMException('quota', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaError({ name: 'NS_ERROR_FILE_NO_DEVICE_SPACE' })).toBe(true);
    expect(isQuotaError(new Error('Failed to execute: Enospc no space left'))).toBe(true);
    expect(isQuotaError(new Error('network down'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});

describe('saveWithFsa 失败分类 → 通知钩子', () => {
  it('QuotaExceededError 触发 quota 提示且返回 false（host 随后 anchor 下载）', async () => {
    const warn = vi.fn();
    setStorageQuotaWarningHook(warn);
    // isSupported 要求 open+save 都存在；open 给个不调用的桩。
    setWindowPicker({
      open: () => Promise.resolve([]),
      save: () => Promise.reject(new DOMException('quota', 'QuotaExceededError')),
    });
    const ok = await saveWithFsa('x.kbnote', '{}');
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe('quota');
  });

  it('用户取消（AbortError）静默，不弹提示', async () => {
    const warn = vi.fn();
    setStorageQuotaWarningHook(warn);
    setWindowPicker({
      open: () => Promise.resolve([]),
      save: () => Promise.reject(new DOMException('canceled', 'AbortError')),
    });
    const ok = await saveWithFsa('x.kbnote', '{}');
    expect(ok).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('普通写盘失败（非配额）触发 write-failed 提示', async () => {
    const warn = vi.fn();
    setStorageQuotaWarningHook(warn);
    setWindowPicker({
      open: () => Promise.resolve([]),
      save: () => Promise.resolve({ createWritable: () => Promise.reject(new Error('disk io')) }),
    });
    const ok = await saveWithFsa('x.kbnote', '{}');
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe('write-failed');
  });
});

describe('ActiveFileManager.writeActiveFile 配额失败通知', () => {
  it('createWritable 抛 QuotaExceededError 时通知钩子并返回 false', async () => {
    const warn = vi.fn();
    setStorageQuotaWarningHook(warn);
    // 直接构造管理器并塞入一个会抛配额错的活动句柄。
    const mgr = new ActiveFileManager();
    // @ts-expect-error 访问私有 activeHandle 注入 mock 句柄
    mgr.activeHandle = {
      createWritable: () => Promise.reject(new DOMException('quota', 'QuotaExceededError')),
    };
    const ok = await mgr.writeActiveFile('{}');
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe('quota');
  });
});

describe('estimateStorageQuota', () => {
  it('navigator.storage.estimate 存在时返回 usage/quota', async () => {
    const nav = navigator as unknown as {
      storage?: { estimate: () => Promise<{ usage: number; quota: number }> };
    };
    nav.storage = { estimate: () => Promise.resolve({ usage: 100, quota: 1000 }) };
    expect(await estimateStorageQuota()).toEqual({ usage: 100, quota: 1000 });
    delete nav.storage;
  });

  it('不支持 estimate 时返回 null', async () => {
    const nav = navigator as unknown as { storage?: { estimate?: unknown } };
    nav.storage = {};
    expect(await estimateStorageQuota()).toBeNull();
    delete nav.storage;
  });
});
