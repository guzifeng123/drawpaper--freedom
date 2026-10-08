import { test, expect } from '@playwright/test';

/**
 * Wave22 A：块内输入 `{{` 唤起跨画布块嵌入浮层 e2e。
 *  ① seed 目标画布 doc_A（一个文本块）；
 *  ② 新画布双击建块 → 输入 `{{` → 继续输入查询词过滤 → Enter 选定目标块；
 *  ③ 块以嵌入形态渲染（data-embed-target 含目标正文、data-embed-source 为来源标题，
 *     且 `{{` 触发字符不在正文里）；
 *  ④ reload 后嵌入仍在；反链索引（backlinksTo）能看到该引用。
 *
 * 注意：page.evaluate 运行在浏览器上下文，构造函数写在内部。
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForFunction(() => window.__drawpaper__ && !!window.__drawpaper__.getState().doc.id);
  await page.waitForTimeout(300);
});

/** 落库 doc_A（被嵌入的目标文档，一个文本块）。 */
async function seedTarget(page: import('@playwright/test').Page, text: string) {
  await page.evaluate((t) => {
    const h = window.__drawpaper__!;
    const pmDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] };
    h.loadFixture({
      format: 'knowledge-block-notes', version: 4, id: 'doc_A', title: '目标画布A',
      board: { createdAt: Date.now(), updatedAt: Date.now() },
      nodes: [{
        id: 'n_A1', type: 'text', x: 0, y: 0, width: 260, height: 80,
        content: { format: 'tiptap-json', data: pmDoc },
        parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {},
      }],
      edges: [], tags: [],
      layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
      viewport: { x: 0, y: 0, zoom: 1 },
      page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: true, colorMode: 'color', header: false, footer: false, showPageNumbers: false, edgeLabels: true, pageBreaks: [] },
      assetRefs: [], links: [],
    } as unknown as Parameters<typeof h.loadFixture>[0]);
    h.invoke('requestSave');
  }, text);
  await page.waitForTimeout(600);
}

test('块内 {{ 触发嵌入：过滤选定 → 嵌入渲染 → reload 持久化 → 反链可见', async ({ page }) => {
  // ① 落库目标画布 A。
  await seedTarget(page, '嵌入目标正文-XYZ');

  // ② 切到一份新画布（空），双击建块进入编辑态。
  await page.evaluate(() => window.__drawpaper__!.invoke('newDoc'));
  await page.waitForTimeout(400);
  const freshId = await page.evaluate(() => window.__drawpaper__!.getState().doc.id);

  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
  await expect(page.locator('.ProseMirror-focused')).toBeVisible({ timeout: 5000 });

  // 输入 `{{` → 浮层弹出；继续输入查询词过滤到目标块。
  await page.keyboard.type('{{嵌入目标正文', { delay: 30 });
  // 浮层候选行出现（目标块代表标题 = 目标正文本身）。
  await expect(page.getByText('嵌入目标正文-XYZ').first()).toBeVisible({ timeout: 3000 });

  // Enter 选定 → 当前块被改造成 doc-embed 嵌入块并退出编辑态。
  await page.keyboard.press('Enter');

  // ③ 以嵌入形态渲染：正文来自 A 的实时解析，头部来源 = 目标画布标题。
  await expect(page.locator('[data-embed-target]')).toContainText('嵌入目标正文-XYZ', { timeout: 3000 });
  await expect(page.locator('[data-embed-source]')).toContainText('目标画布A');
  // 触发字符 `{{` 不残留在正文。
  await expect(page.locator('[data-embed-node]')).not.toContainText('{{');

  // 保存后 links 重建：嵌入即一条出链指向 doc_A。
  await page.evaluate(() => window.__drawpaper__!.invoke('requestSave'));
  await page.waitForTimeout(600);
  const links = await page.evaluate(() => window.__drawpaper__!.currentLinks());
  expect(links).toHaveLength(1);
  expect((links[0] as { targetDocId: string }).targetDocId).toBe('doc_A');

  // ④ reload 后持久化：重新打开新画布，嵌入仍在。
  await page.reload();
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForFunction(() => window.__drawpaper__ && !!window.__drawpaper__.getState().doc.id);
  await page.evaluate((id) => window.__drawpaper__!.invoke('openDoc', id), freshId as string);
  await page.waitForTimeout(800);
  await expect(page.locator('[data-embed-target]')).toContainText('嵌入目标正文-XYZ', { timeout: 3000 });

  // 反链索引：A 块级反链列出新画布这条来源。
  const backlinks = await page.evaluate(() => window.__drawpaper__!.backlinksTo('doc_A', 'n_A1'));
  expect(backlinks.length).toBeGreaterThanOrEqual(1);
});
