import { test, expect } from '@playwright/test';

/**
 * Wave4 P1 总装冒烟：标签筛选 / 放射布局 / 深色持久化 / AI 合入。
 * 稳定优先：复杂逻辑尽量用 DEV 钩子断言，UI 只做主路径点击。
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  // 等 bootstrap 打开文档（异步 listDocs/openDoc）完成，再用 hook 灌数据，避免被覆盖。
  await page.waitForFunction(() => {
    const h = window.__drawpaper__;
    return h && !!h.getState().doc.id;
  });
  await page.waitForTimeout(300);
});

test('标签筛选：创建标签并下发筛选不报错、节点仍在', async ({ page }) => {
  await page.evaluate(() => {
    const h = window.__drawpaper__!;
    h.invoke('addNode', 'text', 0, 0);
    h.invoke('addNode', 'text', 300, 0);
  });
  await page.waitForTimeout(300);
  const tagId = await page.evaluate(() =>
    window.__drawpaper__!.invoke('createTag', '工作', '#ef4444'),
  );
  expect(tagId).toBeTruthy();
  await page.evaluate((tid) => {
    window.__drawpaper__!.invoke('setTagFilter', { tagIds: [tid], match: 'any' });
  }, tagId);
  await page.waitForTimeout(200);
  const count = await page.evaluate(() => window.__drawpaper__!.getState().nodeCount);
  expect(count).toBe(2);
  await page.evaluate(() => window.__drawpaper__!.invoke('clearTagFilter'));
});

test('放射 radial 布局按钮可点、触发整理预览并应用', async ({ page }) => {
  await page.evaluate(() => {
    window.__drawpaper__!.invoke('addNode', 'text', 400, 300);
    window.__drawpaper__!.invoke('addNode', 'text', 700, 200);
  });
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /放射/ }).click();
  await page.waitForTimeout(400);
  const apply = page.getByText('应用');
  if (await apply.isVisible().catch(() => false)) {
    await apply.click();
    await page.waitForTimeout(400);
  }
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
});

test('深色模式切换并持久化 .dark', async ({ page }) => {
  await page.getByRole('button', { name: /主题/ }).click();
  await page.getByText('深色').click();
  await page.waitForTimeout(200);
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
});

test('AI：mock 返回 add-edge 建议 → 合入后边新增', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      'drawpaper.ai.config.v1',
      JSON.stringify({ endpoint: 'http://ai.local/v1', apiKey: 'k', model: 'm', temperature: 0.2 }),
    );
  });
  await page.route('**/chat/completions', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { content: JSON.stringify([
          { kind: 'add-edge', reason: 'connect', source: 'n_1', target: 'n_2' },
        ]) } }],
      }),
    }),
  );
  await page.evaluate(() => {
    window.__drawpaper__!.loadFixture({
      format: 'knowledge-block-notes', version: 3, id: 'doc1', title: 't',
      board: { createdAt: 0, updatedAt: 0 },
      nodes: [
        { id: 'n_1', type: 'text', x: 200, y: 200, width: 200, height: 60, content: { format: 'tiptap-json', data: { type: 'doc', content: [] } }, parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {} },
        { id: 'n_2', type: 'text', x: 600, y: 200, width: 200, height: 60, content: { format: 'tiptap-json', data: { type: 'doc', content: [] } }, parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {} },
      ],
      edges: [], tags: [], layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
      viewport: { x: 0, y: 0, zoom: 1 },
      page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: false, colorMode: 'color', header: false, footer: false, showPageNumbers: false, edgeLabels: true, pageBreaks: [] },
      assetRefs: [], links: [], sync: { vv: {} },
    });
  });
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /AI 辅助/ }).click();
  await page.getByText('一键整理建议').click();
  await expect(page.locator('button:has-text("合入")').first()).toBeVisible({ timeout: 8000 });
  await page.locator('button:has-text("合入")').first().click();
  await page.waitForTimeout(800);
  const edgeCount = await page.evaluate(
    () => window.__drawpaper__!.getState().doc.edges.length,
  );
  expect(edgeCount).toBe(1);
});
