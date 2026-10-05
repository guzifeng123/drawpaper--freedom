import { test, expect } from '@playwright/test';

/**
 * Wave7 P2.1 删块跨文档反链影响确认 + 重命名追踪 e2e：
 *  a. docB 的块被 docA 链接 → 删除 docB 该块弹出确认框、列出《docA》来源；
 *     选「保留为悬挂链接」→ docA chip 变 .is-dangling 且 links 记录仍在；
 *  b. 同样场景选「一并移除」→ docA 中 mark/links 消失；
 *  c. 重命名 docB 目标块 → docA chip 文本变为新标题（reload 后断言）、反链显示新标题；
 *  d. 无链接块删除不弹框（回归原行为）。
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForFunction(() => window.__drawpaper__ && !!window.__drawpaper__.getState().doc.id);
  await page.waitForTimeout(300);
});

/** 在浏览器侧构造并 loadFixture 一份单块文档；带 refMark 时块内嵌 docRef mark。 */
async function seedDoc(
  page: import('@playwright/test').Page,
  doc: { id: string; title: string; blockId: string; text: string; ref?: { targetDocId: string; targetNodeId: string; targetTitle: string } },
) {
  await page.evaluate((d) => {
    const h = window.__drawpaper__!;
    const marks = d.ref
      ? [{ type: 'docRef', attrs: {
          targetDocId: d.ref!.targetDocId, targetNodeId: d.ref!.targetNodeId, targetTitle: d.ref!.targetTitle,
        } }]
      : [];
    const fixture = {
      format: 'knowledge-block-notes' as const, version: 2 as const, id: d.id, title: d.title,
      board: { createdAt: Date.now(), updatedAt: Date.now() },
      nodes: [{
        id: d.blockId, type: 'text' as const, x: 0, y: 0, width: 260, height: 80,
        content: { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: d.text, marks }] }] } },
        parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {},
      }],
      edges: [], tags: [],
      layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
      viewport: { x: 0, y: 0, zoom: 1 },
      page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: true, colorMode: 'color', header: false, footer: false, showPageNumbers: false, edgeLabels: true, pageBreaks: [] },
      assetRefs: [], links: [],
    };
    h.loadFixture(fixture as unknown as Parameters<typeof h.loadFixture>[0]);
    h.invoke('requestSave');
  }, doc);
  await page.waitForTimeout(600);
}

test('a. 删除被引用块：确认框列出《来源文档》；保留为悬挂 → chip 红虚边、links 仍在', async ({ page }) => {
  await seedDoc(page, { id: 'doc_B', title: '目标文档B', blockId: 'n_B1', text: '目标块B' });
  await seedDoc(page, {
    id: 'doc_A', title: '来源文档A', blockId: 'n_A1', text: '看 [[目标块B]]',
    ref: { targetDocId: 'doc_B', targetNodeId: 'n_B1', targetTitle: '目标块B' },
  });

  // 打开 docB，经守卫删除目标块。
  await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'doc_B'));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__drawpaper__!.deleteBlocksGuarded(['n_B1']));

  // 确认框出现，列出《来源文档A》。
  await expect(page.locator('[role=dialog]')).toBeVisible();
  await expect(page.getByText('《来源文档A》')).toBeVisible();

  // 选「保留为悬挂链接」。
  await page.locator('[role=dialog]').getByRole('button', { name: '保留为悬挂链接' }).click();
  await page.waitForTimeout(900);

  // 回 docA：chip 变悬挂（红虚边），links 记录仍在。
  await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'doc_A'));
  await page.waitForTimeout(800);
  const chip = page.locator('.drawpaper-docref').first();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveClass(/is-dangling/);
  const links = await page.evaluate(() => window.__drawpaper__!.currentLinks());
  expect(links).toHaveLength(1);
});

test('b. 删除被引用块：选「一并移除」→ docA 的 mark/links 消失', async ({ page }) => {
  await seedDoc(page, { id: 'doc_B', title: '目标文档B', blockId: 'n_B1', text: '目标块B' });
  await seedDoc(page, {
    id: 'doc_A', title: '来源文档A', blockId: 'n_A1', text: '看 [[目标块B]]',
    ref: { targetDocId: 'doc_B', targetNodeId: 'n_B1', targetTitle: '目标块B' },
  });

  await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'doc_B'));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__drawpaper__!.deleteBlocksGuarded(['n_B1']));

  await expect(page.locator('[role=dialog]')).toBeVisible();
  await page.locator('[role=dialog]').getByRole('button', { name: '一并移除这些链接' }).click();
  // 等待级联：同文档 macro + 跨文档 Dexie 回写。
  await page.waitForTimeout(1200);

  // 回 docA：chip 消失、links 记录为空。
  await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'doc_A'));
  await page.waitForTimeout(800);
  await expect(page.locator('.drawpaper-docref')).toHaveCount(0);
  const links = await page.evaluate(() => window.__drawpaper__!.currentLinks());
  expect(links).toHaveLength(0);
});

test('c. 重命名目标块 → docA chip 文本刷新（reload 后）、反链显示新标题', async ({ page }) => {
  await seedDoc(page, { id: 'doc_B', title: '目标文档B', blockId: 'n_B1', text: '目标块B' });
  await seedDoc(page, {
    id: 'doc_A', title: '来源文档A', blockId: 'n_A1', text: '看 [[目标块B]]',
    ref: { targetDocId: 'doc_B', targetNodeId: 'n_B1', targetTitle: '目标块B' },
  });

  // 在 docB 里把目标块正文改为「新标题C」，保存触发重命名对账。
  await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'doc_B'));
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const h = window.__drawpaper__!;
    h.invoke('updateContent', 'n_B1', {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '新标题C' }] }],
    });
    h.invoke('requestSave');
  });
  // 等待 autosave(500ms) + syncBacklinkTitles 跨文档回写。
  await page.waitForTimeout(1800);

  // 反链（docB 视角）应显示新标题。
  const backlinks = await page.evaluate(() => window.__drawpaper__!.backlinksTo('doc_B', 'n_B1'));
  expect(backlinks).toHaveLength(1);
  expect((backlinks[0] as { sourceNodeTitle: string }).sourceNodeTitle).toContain('新标题C');

  // reload docA：chip 文本变为新标题。
  await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'doc_A'));
  await page.waitForTimeout(800);
  const chip = page.locator('.drawpaper-docref').first();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('新标题C');
});

test('d. 无链接块删除不弹框（回归原行为）', async ({ page }) => {
  await seedDoc(page, { id: 'doc_C', title: '孤立文档C', blockId: 'n_C1', text: '没有任何引用' });
  await page.waitForTimeout(300);

  await page.evaluate(() => window.__drawpaper__!.deleteBlocksGuarded(['n_C1']));
  await page.waitForTimeout(500);

  // 不弹确认框。
  await expect(page.locator('[role=dialog]')).toHaveCount(0);
  // 块已删。
  const nodeCount = await page.evaluate(() => window.__drawpaper__!.getState().nodeCount);
  expect(nodeCount).toBe(0);
});
