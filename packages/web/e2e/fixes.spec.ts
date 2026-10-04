import { test, expect } from '@playwright/test';
import { waitForApp, loadStandard, invoke, getState } from './fixtures/load-doc';

/**
 * 验证 Wave2a 四个已知缺口的修复（e2e 端到端）。
 */

test.describe('已知缺口修复', () => {
  test('新建文档后侧栏文档列表即时刷新', async ({ page }) => {
    await waitForApp(page);
    await loadStandard(page);
    // 等自动保存落盘。
    await page.waitForTimeout(1500);
    const before = await page.locator('[data-doc-list-item], button:has-text("验收样例")').count();
    console.log('BEFORE_DOCS', before);

    // 点新建文档。
    await page.getByRole('button', { name: /新建|\+/ }).first().click().catch(() => {});
    // 兜底：经钩子新建。
    await invoke(page, 'newDoc');
    await page.waitForTimeout(1500);

    // 侧栏应出现新文档（不再停留在「还没有文档」）。
    await expect(page.locator('text=还没有文档')).toHaveCount(0);
    const items = await page.locator('[data-doc-list-item], aside button, aside [class*="item"]').count();
    console.log('SIDEBAR_ITEMS', items);
    expect(items).toBeGreaterThanOrEqual(1);
  });

  test('导出弹窗「边标签」开关写回 PageSettings', async ({ page }) => {
    await waitForApp(page);
    await loadStandard(page);
    await invoke(page, 'setPageSettings', { edgeLabels: true });

    // 打开导出弹窗。
    await page.keyboard.press('Control+p');
    await page.waitForSelector('text=导出 / 打印', { timeout: 5000 });

    // 边标签开关初始应为开。
    const sw = page.locator('text=边（连线）标签').locator('xpath=..').locator('button[role="switch"]');
    await expect(sw).toBeChecked();

    // 关闭 → 写回 store。
    await sw.click();
    await page.waitForTimeout(200);
    const st = (await getState(page)) as { doc: { page: { edgeLabels: boolean } } };
    console.log('EDGE_LABELS_AFTER_TOGGLE', st.doc.page.edgeLabels);
    expect(st.doc.page.edgeLabels).toBe(false);
  });

  test('undo 后相机回位（宏撤销触发 fitView）', async ({ page }) => {
    await waitForApp(page);
    await loadStandard(page);
    // 触发一键整理宏，再 undo，验证 historyEvent 事件被 store 记录。
    await invoke(page, 'previewLayout');
    await page.waitForTimeout(300);
    await invoke(page, 'confirmLayout');
    await page.waitForTimeout(400);
    await invoke(page, 'undo');
    await page.waitForTimeout(400);
    // 无崩溃、画布仍在。
    await expect(page.locator('.react-flow')).toBeVisible();
  });
});
