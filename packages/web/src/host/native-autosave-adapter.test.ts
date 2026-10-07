import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assetRelPath,
  bytesToBase64,
  docRelPath,
  getNativeAutosaveDir,
  initNativeAutosave,
  isNativeAutosaveRuntime,
} from './native-autosave-adapter';
import { editorStore } from '@/store/editor-store';

/** invoke 记录 + 可定制返回值；opfs getAsset 打桩。 */
const { invokeCalls, invokeImpl, getAssetMock } = vi.hoisted(() => ({
  invokeCalls: [] as Array<{ cmd: string; args?: Record<string, unknown> }>,
  invokeImpl: vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    invokeCalls.push({ cmd, args });
    return null;
  }),
  getAssetMock: vi.fn(async (_ref: string) => null as Blob | null),
}));

vi.mock('@/storage/opfs', () => ({
  getAsset: (...args: unknown[]) => getAssetMock(...(args as [string])),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));
/** 等过 500ms 防抖 + 一轮异步落盘。 */
const settleDebounce = () => new Promise((r) => setTimeout(r, 650));

describe('Wave17 native-autosave adapter 纯函数', () => {
  it('文档/资产相对路径与 FSA 通道逐字节一致', () => {
    expect(docRelPath('doc-abc')).toBe('doc-abc.kbnote');
    expect(assetRelPath('deadbeefcafe')).toBe('assets/deadbeefcafe');
  });

  it('bytesToBase64 标准 base64 可往返解码', () => {
    const bytes = new TextEncoder().encode('{"format":"knowledge-block-notes"}');
    const b64 = bytesToBase64(bytes);
    expect(b64).not.toContain('\n');
    expect(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).toBe(
      '{"format":"knowledge-block-notes"}',
    );
  });
});

describe('Wave17 native-autosave 浏览器/no-Tauri 整体 no-op', () => {
  it('无 __TAURI__：运行时检测为 false、getDir 返回 null、init 不抛错', async () => {
    expect(isNativeAutosaveRuntime()).toBe(false);
    expect(await getNativeAutosaveDir()).toBeNull();
    const dispose = initNativeAutosave();
    expect(typeof dispose).toBe('function');
    expect(() => dispose()).not.toThrow();
  });
});

describe('Wave17 native-autosave Tauri 配置后镜像落盘', () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    invokeCalls.length = 0;
    invokeImpl.mockClear();
    getAssetMock.mockClear();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    delete (window as unknown as Record<string, unknown>).__TAURI__;
  });

  it('已配置目录 → 防抖后写 .kbnote 本体 + assets/<ref>，资产去重', async () => {
    // get_dir 返回已配置目录；其余命令默认 null。
    invokeImpl.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      invokeCalls.push({ cmd, args });
      if (cmd === 'autosave_get_dir') return '/tmp/fake-autosave';
      return null;
    });
    (window as unknown as Record<string, unknown>).__TAURI__ = {
      core: { invoke: invokeImpl },
    };

    // 模拟一个资产 blob（OPFS 读出）。jsdom 的 Blob 无 arrayBuffer()，
    // 这里给一个带 arrayBuffer 的最小 duck-type（与真 Blob 同形）。
    const assetBytes = new TextEncoder().encode('IMG-BYTES');
    getAssetMock.mockResolvedValue({
      arrayBuffer: async () => assetBytes.buffer,
    } as unknown as Blob);

    dispose = initNativeAutosave();
    await flush(); // get_dir promise resolve → setActive → scheduleFlush(500ms)
    await settleDebounce(); // 等过首轮防抖落盘（boot 文档，无资产）
    await flush();

    // 往当前文档挂一个资产引用 → 触发新一轮防抖落盘。
    editorStore.setState((s) => ({
      doc: { ...s.doc, assetRefs: ['deadbeefcafe'] },
    }));
    await settleDebounce();
    await flush();

    const writes = invokeCalls.filter((c) => c.cmd === 'autosave_write_file');
    // 文档本体：<docId>.kbnote
    const docWrite = writes.find((c) => String(c.args?.relPath).endsWith('.kbnote'));
    expect(docWrite).toBeDefined();
    expect(String(docWrite!.args!.relPath)).toMatch(/^[\w.-]+\.kbnote$/);
    // 资产：assets/<ref>，且只写一次（本会话去重）。
    const assetWrites = writes.filter((c) => String(c.args?.relPath).startsWith('assets/'));
    expect(assetWrites.length).toBe(1);
    expect(String(assetWrites[0]!.args!.relPath)).toBe('assets/deadbeefcafe');
  });

  it('写盘失败（invoke reject）静默降级、不抛错', async () => {
    invokeImpl.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      invokeCalls.push({ cmd, args });
      if (cmd === 'autosave_get_dir') return '/tmp/fake-autosave';
      throw new Error('disk full');
    });
    (window as unknown as Record<string, unknown>).__TAURI__ = {
      core: { invoke: invokeImpl },
    };
    dispose = initNativeAutosave();
    await flush();
    await expect(settleDebounce()).resolves.not.toThrow();
    await flush();
    // 即使写失败，文档写调用仍被发出（下轮重试），且未向上抛出。
    expect(invokeCalls.some((c) => c.cmd === 'autosave_write_file')).toBe(true);
  });
});
