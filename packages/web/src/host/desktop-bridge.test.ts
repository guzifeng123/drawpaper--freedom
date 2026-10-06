import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeWindowTitle, initDesktopBridge, isTauriRuntime } from './desktop-bridge';
import { registerViewActionHandler, type ViewAction } from '../editor/state/view-bus';
import { serializeKBNote, CURRENT_DOC_VERSION, type KBNoteDoc } from '@drawpaper/core';

/** toast 模块打桩：断言「打开失败」轻量 toast 被调用。 */
const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock('@/panels/lib/toast', () => ({
  pushToast: (...args: unknown[]) => toastSpy(...args),
}));

function blankDoc(): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: CURRENT_DOC_VERSION,
    id: 'wave14-test',
    title: '缩放桥测试',
    board: { createdAt: Date.now(), updatedAt: Date.now() },
    nodes: [],
    edges: [],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: {
      size: 'A4',
      orientation: 'portrait',
      marginMm: 15,
      mode: 'fit',
      showPageBreak: true,
      colorMode: 'color',
      header: false,
      footer: false,
      showPageNumbers: false,
      edgeLabels: true,
      pageBreaks: [],
    },
    assetRefs: [],
    links: [],
    sync: { vv: {} },
  };
}

/** 注入 __TAURI__ 桩：core.invoke 记录调用；event.listen 按事件名收集 handler。 */
function stubTauri() {
  const invokeCalls: Array<{ cmd: string; args?: unknown }> = [];
  const listeners: Record<string, Array<(e: { payload: unknown }) => void>> = {};
  ;
  (window as unknown as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: vi.fn(async (cmd: string, args?: unknown) => {
        invokeCalls.push({ cmd, args });
        return null;
      }),
    },
    event: {
      listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
        (listeners[event] ??= []).push(handler);
        return () => undefined;
      }),
    },
  };
  return { invokeCalls, listeners };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

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

describe('Wave14 视图菜单转发（Tauri 运行时）', () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    toastSpy.mockClear();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    registerViewActionHandler(null);
    delete (window as unknown as Record<string, unknown>).__TAURI__;
  });

  it('view:fit / view:zoom-in / view:zoom-out 转发到同一批画布动作', async () => {
    const { listeners } = stubTauri();
    const seen: ViewAction[] = [];
    registerViewActionHandler((a) => seen.push(a));

    dispose = initDesktopBridge();
    await flush();
    await flush();

    const menu = listeners['app:menu'];
    expect(menu?.length ?? 0).toBeGreaterThan(0);
    const fire = (id: string) => menu![0]!({ payload: { id } });

    fire('view:fit');
    fire('view:zoom-in');
    fire('view:zoom-out');

    expect(seen).toEqual(['fit', 'zoom-in', 'zoom-out']);
  });

  it('富 app:open-file 载荷走 parseKBNote→loadDoc→bindNativeFile', async () => {
    const { invokeCalls, listeners } = stubTauri();
    dispose = initDesktopBridge();
    await flush();
    await flush();

    const text = serializeKBNote(blankDoc());
    const openFile = listeners['app:open-file'];
    expect(openFile?.length ?? 0).toBeGreaterThan(0);
    openFile![0]!({
      payload: { path: 'C:/docs/笔记本.kbnote', name: '笔记本.kbnote', text, external: true },
    });
    // 等 routeOpenFile 的 await bindNativeFile 落定。
    await flush();
    await flush();

    const bindCall = invokeCalls.find((c) => c.cmd === 'bind_native_file');
    expect(bindCall).toBeTruthy();
    expect(bindCall!.args).toMatchObject({ path: 'C:/docs/笔记本.kbnote' });
  });

  it('app:open-file-error 事件 → 前端 toast 一句友好提示', async () => {
    const { listeners } = stubTauri();
    dispose = initDesktopBridge();
    await flush();
    await flush();

    const errListener = listeners['app:open-file-error'];
    expect(errListener?.length ?? 0).toBeGreaterThan(0);
    errListener![0]!({
      payload: { path: 'C:/docs/gone.kbnote', message: '无法打开文件：os error 2 (file not found)' },
    });
    await flush();

    expect(toastSpy).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('无法打开文件'),
    );
  });
});
