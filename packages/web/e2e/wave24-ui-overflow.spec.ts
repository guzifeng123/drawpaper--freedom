/**
 * Wave24 UI 溢出修复回归：
 *  - 右下角自建缩放控件（百分比/1:1）不得压在 MiniMap 上；
 *  - 左下角 React Flow Controls 不得压在文档列表（展开 w-56 / 收起 w-10 轨道）上；
 *  - 桌面展开/收起两种状态、窄屏（390px）收起轨道状态均断言。
 */
import { test, expect } from '@playwright/test';

const intersects = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

test.describe('Wave24 画布按钮不突出/不重叠', () => {
  test('桌面宽度：缩放控件不压 MiniMap，Controls 不压文档面板（展开态）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await page.waitForTimeout(1000);
    // 造块，确保 MiniMap 挂载且画布有内容
    await page.mouse.click(700, 400);
    await page.waitForTimeout(200);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);

    const minimap = page.locator('.react-flow__minimap').first();
    await expect(minimap).toBeVisible();
    const mm = (await minimap.boundingBox())!;
    // 右下角共两个 Panel：MiniMap 容器 + 自建缩放 pill，取后者（不含 minimap 类）
    const pill = page.locator('.react-flow__panel.bottom.right').nth(1);
    const pb = (await pill.boundingBox())!;
    expect(intersects(pb, mm)).toBe(false);

    const controls = page.locator('.react-flow__controls').first();
    const cb = (await controls.boundingBox())!;
    const aside = page.locator('aside').first();
    const ab = (await aside.boundingBox())!;
    expect(intersects(cb, ab)).toBe(false);
  });

  test('桌面宽度：收起文档列表后 Controls 不压 40px 轨道', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await page.waitForTimeout(800);
    // 点击文档面板内的收起按钮（title 为收起的按钮，DocsListPanel 用折叠图标按钮）
    const collapse = page.getByRole('button', { name: /收起文档列表|收起/ }).first();
    await collapse.click().catch(() => {});
    await page.waitForTimeout(400);

    const controls = page.locator('.react-flow__controls').first();
    const cb = (await controls.boundingBox())!;
    const rail = page.locator('aside').first();
    const rb = (await rail.boundingBox())!;
    expect(rb.width).toBeLessThanOrEqual(48);
    expect(intersects(cb, rb)).toBe(false);
  });

  test('窄屏 390px：Controls 不压文档轨道，缩放 pill 不压 MiniMap', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.mouse.click(300, 400);
    await page.waitForTimeout(200);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);

    const controls = page.locator('.react-flow__controls').first();
    const cb = (await controls.boundingBox())!;
    const rail = page.locator('aside').first();
    const rb = (await rail.boundingBox())!;
    expect(intersects(cb, rb)).toBe(false);

    const minimap = page.locator('.react-flow__minimap').first();
    if (await minimap.isVisible().catch(() => false)) {
      const mm = (await minimap.boundingBox())!;
      const pill = page.locator('.react-flow__panel.bottom.right').nth(1);
      const pb = (await pill.boundingBox())!;
      expect(intersects(pb, mm)).toBe(false);
    }
  });
});
