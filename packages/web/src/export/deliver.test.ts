import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverExportFile } from './deliver';
import { resetTauriExportHost } from '@/host/tauri-host';

/**
 * Wave13：导出交付 sink 单测。
 *  - 浏览器宿主（无 __TAURI__）：走 Blob URL 下载，不调 save_export。
 *  - 桌面宿主：cancelled 静默（不 toast）、saved 不 toast、reject → toast 写盘失败。
 */

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('@/panels/lib/toast', () => ({ pushToast: (kind: string, msg: string) => toast[kind as 'error']?.(msg) }));

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI__;
  resetTauriExportHost();
  toast.error.mockClear();
});

describe('deliverExportFile', () => {
  it('浏览器宿主：创建 Blob URL 并触发下载，不调 save_export', async () => {
    // jsdom 无 URL.createObjectURL，先打桩。
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn(() => undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    // 无 __TAURI__ → getTauriExportHost() 为 null。
    await deliverExportFile('a_20261006_纵向.pdf', 'pdf', new Blob(['%PDF']));
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('桌面宿主：cancelled 静默，不弹错误 toast', async () => {
    let captured: Record<string, unknown> | undefined;
    ;
    (window as unknown as Record<string, unknown>).__TAURI__ = {
      core: {
        invoke: vi.fn(async (_cmd: string, args?: Record<string, unknown>) => {
          captured = args;
          return { status: 'cancelled' };
        }),
      },
      event: { listen: vi.fn(async () => () => undefined) },
    };
    await deliverExportFile('n_20261006_横向.png', 'png', new Blob(['x']));
    expect(captured).toMatchObject({ suggestedName: 'n_20261006_横向.png', ext: 'png' });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('桌面宿主：reject 写盘失败 → toast', async () => {
    (window as unknown as Record<string, unknown>).__TAURI__ = {
      core: {
        invoke: vi.fn(async () => {
          throw 'disk full';
        }),
      },
      event: { listen: vi.fn(async () => () => undefined) },
    };
    await deliverExportFile('n.md', 'md', new Blob(['x']));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('导出保存失败'));
  });
});
