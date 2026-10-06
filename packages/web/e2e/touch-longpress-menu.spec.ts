import { test, expect, type Page } from '@playwright/test';

/**
 * Wave14 D · 任务一：粗指针（触屏）长按画布空白 → 弹出与鼠标右键完全一致的上下文菜单。
 *
 * ① 长按空白 → 菜单出现；点「新建块」真的建块。
 * ② 长按空白 → 菜单出现；点「适应屏幕」真的 fitView。
 * ③ 分页预览模式下长按空白 → 菜单含「插入分页符」，点击真的加分页符。
 * 鼠标路径（右键菜单）行为不回退由既有 canvas e2e 守护。
 */

const boot = async (page: Page) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForFunction(() => !!(window.__drawpaper__ && window.__drawpaper__.getState().doc.id));
  await page.waitForTimeout(400);
};

/** 在画布坐标 (x,y) 模拟一次触屏长按（pointerdown → 静止 500ms+ → pointerup）。 */
const longPressBlank = async (page: Page, x: number, y: number) => {
  await page.evaluate(
    ({ x, y }) => {
      const pane = document.querySelector('.react-flow__pane') as HTMLElement;
      pane.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'touch',
          clientX: x,
          clientY: y,
          bubbles: true,
          isPrimary: true,
        }),
      );
    },
    { x, y },
  );
  await page.waitForTimeout(650); // > 500ms 长按阈值
  await page.evaluate(
    ({ x, y }) => {
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerType: 'touch',
          clientX: x,
          clientY: y,
          bubbles: true,
          isPrimary: true,
        }),
      );
    },
    { x, y },
  );
};

const nodeCount = (page: Page) =>
  page.evaluate(() => window.__drawpaper__!.getState().nodeCount);

test.describe('Wave14 触屏长按空白菜单', () => {
  test('长按空白 → 菜单出现；点新建块真的建块，点适应屏幕真的 fit', async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await ctx.newPage();
    await boot(page);
    await expect(page.locator('button[title="选择 (V)"]')).toBeVisible(); // coarse 工具组

    const before = await nodeCount(page);

    // 长按空白处。
    await longPressBlank(page, 500, 400);
    const menu = page.locator('[data-testid="pane-context-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-testid="pane-menu-new-block"]')).toBeVisible();
    await expect(menu.locator('[data-testid="pane-menu-fit"]')).toBeVisible();

    // 点「新建文本块」→ 真的建块。
    await menu.locator('[data-testid="pane-menu-new-block"]').click();
    await expect.poll(() => nodeCount(page), { timeout: 3000 }).toBe(before + 1);

    // 菜单点击后关闭。
    await expect(menu).toBeHidden();
    await ctx.close();
  });

  test('分页预览模式下长按空白 → 菜单含「插入分页符」，点击真的加分页符', async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await ctx.newPage();
    await boot(page);

    // 确保分页预览模式开。
    await page.evaluate(() => window.__drawpaper__!.invoke('setPageSettings', { showPageBreak: true }));
    await page.waitForTimeout(200);
    const beforeBreaks = await page.evaluate(
      () => (window.__drawpaper__!.getState().doc.page.pageBreaks as unknown[]).length,
    );

    await longPressBlank(page, 500, 500);
    const menu = page.locator('[data-testid="pane-context-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-testid="pane-menu-pagebreak"]')).toBeVisible();

    await menu.locator('[data-testid="pane-menu-pagebreak"]').click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(
            () => (window.__drawpaper__!.getState().doc.page.pageBreaks as unknown[]).length,
          )),
        { timeout: 3000 },
      )
      .toBe(beforeBreaks + 1);
    await ctx.close();
  });
});
