import { test, expect } from '@playwright/test';

test('probe: export dialog page-preview toggle mounts overlay', async ({ page }) => {
  await page.goto('/');
  await page.dblclick('body', { position: { x: 400, y: 300 } });
  await page.waitForTimeout(300);
  await page.keyboard.type('探针块');
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+p');
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  const sw = dlg.locator('button[role="switch"]').first();
  await sw.click();
  await page.waitForTimeout(800);
  const badge = page.getByText(/分页预览中/);
  const visible = await badge.isVisible().catch(() => false);
  console.log('PREVIEW_BADGE_VISIBLE', visible);
  expect(visible).toBeTruthy();
});
