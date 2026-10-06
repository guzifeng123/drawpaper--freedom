import { test, expect } from '@playwright/test';
import { waitForApp } from './fixtures/load-doc';

/**
 * Wave13 阶段 B：桌面端欢迎文档 / 导出接线 e2e。
 *
 * Linux CI 跑的是真实浏览器（无 __TAURI__），无法跑 Tauri WebView：
 *  - 断言①：浏览器环境启动后绝不创建欢迎文档（无宿主检测即短路）。
 *  - 断言②：用 dev-hooks 模拟宿主标志（注入 __TAURI__ 桩 + 清标记），
 *    走真实 shouldCreateWelcomeDoc → buildWelcomeDoc → loadDoc 流程，
 *    断言创建出「欢迎使用 drawpaper」。
 *
 * 注意：page.evaluate 会序列化返回值，方法不能跨边界带出——所有
 * __drawpaper__ 方法调用都必须在 evaluate 内部完成。
 */

test.describe('Wave13 欢迎文档首跑逻辑', () => {
  test('浏览器环境：不检测到宿主、不创建欢迎文档、无标记', async ({ page }) => {
    await waitForApp(page);
    const result = await page.evaluate(() => {
      const h = (window as unknown as {
        __drawpaper__: {
          welcomeDetectHost(): boolean;
          welcomeFlagSet(): boolean;
          welcomeRunFirstRunFlow(): { created: boolean };
          getState(): { doc: { title: string } };
        };
      }).__drawpaper__;
      return {
        detected: h.welcomeDetectHost(),
        flagSet: h.welcomeFlagSet(),
        flow: h.welcomeRunFirstRunFlow(),
        title: h.getState().doc.title,
      };
    });
    expect(result.detected).toBe(false);
    expect(result.flagSet).toBe(false);
    expect(result.flow.created).toBe(false);
    expect(result.title).not.toBe('欢迎使用 drawpaper');
  });

  test('dev-hooks 模拟宿主：注入 __TAURI__ + 清标记 → 创建欢迎文档', async ({ page }) => {
    await waitForApp(page);
    // 注入 Tauri 宿主桩（duck-type），清空已创建标记，跑首跑流程。
    const result = await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = { core: {}, event: {} };
      const h = (window as unknown as {
        __drawpaper__: {
          welcomeDetectHost(): boolean;
          welcomeFlagSet(): boolean;
          welcomeClearFlag(): void;
          welcomeRunFirstRunFlow(): { created: boolean; title?: string };
        };
      }).__drawpaper__;
      h.welcomeClearFlag();
      const detectedBefore = h.welcomeDetectHost();
      const flow = h.welcomeRunFirstRunFlow();
      const flagAfter = h.welcomeFlagSet();
      const flowAgain = h.welcomeRunFirstRunFlow();
      return { detectedBefore, flow, flagAfter, flowAgain };
    });
    expect(result.detectedBefore).toBe(true);
    expect(result.flow.created).toBe(true);
    expect(result.flow.title).toBe('欢迎使用 drawpaper');
    expect(result.flagAfter).toBe(true);
    // 有标记后再次跑首跑流程：不再创建。
    expect(result.flowAgain.created).toBe(false);
  });
});
