import { afterEach, describe, expect, it, vi } from 'vitest';
import { TauriHostAdapter, resetTauriExportHost } from './tauri-host';

/**
 * Wave13：TauriHostAdapter.save_export 接线单测。
 *  - 四类导出都把 suggestedName（含标题/日期/方向/扩展名）逐字传给 Rust，
 *    bytesBase64 非空；
 *  - cancelled 是正常 resolve（不 reject、不抛错），调用方据此静默；
 *  - write 失败 reject(string) 透传给调用方（由 deliver sink toast）。
 */

interface InvokeCall {
  cmd: string;
  args?: Record<string, unknown>;
}

function stubTauri(handler: (cmd: string, args?: Record<string, unknown>) => unknown) {
  const calls: InvokeCall[] = [];
  ;
  (window as unknown as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return handler(cmd, args);
      }),
    },
    event: { listen: vi.fn(async () => () => undefined) },
  };
  return calls;
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI__;
  resetTauriExportHost();
});

describe('TauriHostAdapter.saveExport', () => {
  it('PDF：suggestedName 逐字含标题/日期/方向/扩展名，bytesBase64 非空', async () => {
    const calls = stubTauri(async () => ({ status: 'saved', path: 'C:/x/notes.pdf' }));
    const a = new TauriHostAdapter();
    const blob = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' });
    const out = await a.saveExport({
      suggestedName: '读书笔记_20261006_横向.pdf',
      ext: 'pdf',
      bytes: blob,
    });
    expect(out).toEqual({ status: 'saved', path: 'C:/x/notes.pdf' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('save_export');
    expect(calls[0]!.args).toMatchObject({
      suggestedName: '读书笔记_20261006_横向.pdf',
      ext: 'pdf',
    });
    const b64 = calls[0]!.args!.bytesBase64 as string;
    expect(typeof b64).toBe('string');
    expect(b64.length).toBeGreaterThan(0);
    expect(atob(b64)).toBe('%PDF-1.4 fake');
  });

  it('PNG / SVG / MD：ext 分别透传 png/svg/md', async () => {
    const calls = stubTauri(async () => ({ status: 'saved', path: 'x' }));
    const a = new TauriHostAdapter();
    for (const ext of ['png', 'svg', 'md'] as const) {
      calls.length = 0;
      await a.saveExport({ suggestedName: `n.${ext}`, ext, bytes: new Blob(['data']) });
      expect(calls[0]!.args!.ext).toBe(ext);
    }
  });

  it('cancelled 作为正常 resolve 返回（不 reject）', async () => {
    stubTauri(async () => ({ status: 'cancelled' }));
    const a = new TauriHostAdapter();
    const out = await a.saveExport({
      suggestedName: 'a_20261006_纵向.png',
      ext: 'png',
      bytes: new Blob(['x']),
    });
    expect(out).toEqual({ status: 'cancelled' });
  });

  it('写盘失败 reject(string) 原样抛出', async () => {
    stubTauri(async () => {
      throw 'disk full: 写盘失败';
    });
    const a = new TauriHostAdapter();
    await expect(
      a.saveExport({ suggestedName: 'a.pdf', ext: 'pdf', bytes: new Blob(['x']) }),
    ).rejects.toBe('disk full: 写盘失败');
  });
});
