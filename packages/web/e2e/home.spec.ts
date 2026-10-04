import { test, expect } from '@playwright/test';

test('home renders the Wave 0 canvas shell', async ({ page }) => {
  await page.goto('/');
  // 顶部 shell 标记可见
  await expect(page.getByText('Wave 0 shell')).toBeVisible();
  // React Flow 画布容器挂载
  await expect(page.locator('.react-flow')).toBeVisible();
});
