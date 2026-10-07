import { test, expect } from '@playwright/test';

/**
 * Wave17：原生文件夹自动保存。
 *
 * 在浏览器里 mock 一套最小 __TAURI__（core.invoke 记录所有命令调用）：
 *   1. 配置目录（autosave_get_dir 返回 /tmp/fake-autosave）→ 编辑文档 →
 *      断言按 FSA 通道同款相对路径收到 `<docId>.kbnote` 文档写调用；
 *   2. 取消配置（DEV 钩子 setConfigured(null)）→ 再编辑 → 断言不再产生写调用。
 *
 * 浏览器/no-Tauri 行为零变化：本用例只在显式注入 __TAURI__ 时激活镜像。
 */

test.describe('Wave17 原生文件夹自动保存', () => {
  test('配置目录→编辑→按 FSA 同款路径写盘；取消后不再写', async ({ page }) => {
    // 在任何页面脚本之前注入记录型 __TAURI__：
    //   - autosave_get_dir 返回已配置目录 → adapter 启动即激活镜像；
    //   - 其余命令记录后返回 null（桌面桥 setWindowTitle 等都能跑过）。
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__invokeLog = [];
      const log = w.__invokeLog as Array<{ cmd: string; args?: Record<string, unknown> }>;
      w.__TAURI__ = {
        core: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            log.push({ cmd, args });
            if (cmd === 'autosave_get_dir') return '/tmp/fake-autosave';
            return null;
          },
        },
        event: {
          listen: async () => () => undefined,
          emit: () => undefined,
        },
      };
      // 跳过欢迎文档引导，直接进空白/最近文档。
      try {
        localStorage.setItem('drawpaper:welcome-doc-v1', '1');
      } catch {
        /* ignore */
      }
    });

    await page.goto('/');
    await expect(page.locator('.react-flow')).toBeVisible();
    // 等 bootstrap 文档就绪。
    await page.waitForFunction(() => {
      const h = window.__drawpaper__;
      return h && !!h.getState().doc.id;
    });
    // adapter init 在 mount 后异步取 get_dir；等其激活。
    await page.waitForTimeout(800);

    // 1) 编辑文档：加一个节点 → store.doc 引用变化 → adapter 500ms 防抖落盘。
    await page.evaluate(() => {
      window.__drawpaper__!.invoke('addNode', 'text', 100, 100);
    });
    // 等过防抖 + 一轮落盘。
    await page.waitForTimeout(1200);

    const writes1 = await page.evaluate(() =>
      (window as unknown as { __invokeLog: Array<{ cmd: string; args?: Record<string, unknown> }> })
        .__invokeLog.filter((c) => c.cmd === 'autosave_write_file'),
    );
    // 文档本体：<docId>.kbnote（与 FSA pushDoc 同款根路径）。
    const docWrite = writes1.find((c) => String(c.args?.relPath).endsWith('.kbnote'));
    expect(docWrite, '应按 <docId>.kbnote 写文档本体').toBeTruthy();
    expect(String(docWrite!.args!.relPath)).toMatch(/^[\w.-]+\.kbnote$/);

    // 2) 取消配置：DEV 钩子把镜像开关置 null。
    await page.evaluate(() => {
      const h = (window as unknown as { __nativeAutosave?: { setConfigured: (d: string | null) => void } })
        .__nativeAutosave;
      h?.setConfigured(null);
    });
    await page.waitForTimeout(200);

    const countBefore = await page.evaluate(
      () =>
        (window as unknown as { __invokeLog: Array<{ cmd: string }> }).__invokeLog.filter(
          (c) => c.cmd === 'autosave_write_file',
        ).length,
    );

    // 3) 再编辑一次 → 不应再产生写盘调用。
    await page.evaluate(() => {
      window.__drawpaper__!.invoke('addNode', 'text', 500, 200);
    });
    await page.waitForTimeout(1200);

    const countAfter = await page.evaluate(
      () =>
        (window as unknown as { __invokeLog: Array<{ cmd: string }> }).__invokeLog.filter(
          (c) => c.cmd === 'autosave_write_file',
        ).length,
    );
    expect(countAfter, '取消配置后不应再有新的写盘调用').toBe(countBefore);
  });
});
