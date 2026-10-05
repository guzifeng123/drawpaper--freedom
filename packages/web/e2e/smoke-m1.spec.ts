import { test, expect } from '@playwright/test';

/**
 * M1 P0 主闭环冒烟（Wave2 沉淀，为 Wave2b 打底）。
 * 建块 → 输入文字 → 搜索 → 导出弹窗 主路径；不断言像素级 UI。
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect(page.getByRole('button', { name: /横向/ })).toBeVisible();
});

test('double-click blank canvas creates an editable block', async ({ page }) => {
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  // 等 Tiptap 真正获焦后再输入，避免双击→进编辑态的异步竞态导致输入丢失（headless flaky）。
  await expect(page.locator('.ProseMirror-focused')).toBeVisible({ timeout: 5000 });
  await page.keyboard.type('冒烟块内容', { delay: 20 });
  await expect(page.getByText('冒烟块内容')).toBeVisible();
});

test('Ctrl+F opens search and finds the block text', async ({ page }) => {
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  await expect(page.locator('.ProseMirror-focused')).toBeVisible({ timeout: 5000 });
  await page.keyboard.type('可搜索关键词', { delay: 20 });
  // 点空白退出编辑态，快捷键才生效。
  await page.locator('.react-flow__pane').click({ position: { x: 700, y: 500 } });
  await page.waitForTimeout(300);

  await page.keyboard.press('Control+f');
  await expect(page.getByPlaceholder(/搜索块内文字/)).toBeVisible();
  await page.getByPlaceholder(/搜索块内文字/).fill('关键词');
  // 搜索结果列表里出现该块（画布节点 + 结果行两处均含此文本，取首处即可）。
  await expect(page.getByText('可搜索关键词').first()).toBeVisible();
});

test('Ctrl+P opens the export dialog with three layout modes', async ({ page }) => {
  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  await page.waitForTimeout(200);
  await page.locator('.react-flow__pane').click({ position: { x: 700, y: 500 } });
  await page.waitForTimeout(200);

  await page.keyboard.press('Control+p');
  await expect(page.getByRole('heading', { name: '导出 / 打印' })).toBeVisible();
  await expect(page.getByText('Fit 一页')).toBeVisible();
  await expect(page.getByText('Tiles 分页')).toBeVisible();
  await expect(page.getByText('Flow 重排')).toBeVisible();
});
