import { test, expect } from '@playwright/test';

/**
 * Wave20 跨画布只读块嵌入（block transclusion）e2e：
 *  ① A 画布建富文本块 → B 画布嵌入 → B 中可见正文；
 *  ② 改 A 块内容 → 重新打开 B → 显示新内容（实时只读解析）；
 *  ③ 删 A 中目标块 → B 显示悬挂占位且不报错；
 *  ④ SVG/矢量 PDF 导出产物含嵌入正文与来源标题；
 *  ⑤ A 的反链面板数据列出来源 B；
 *  ⑥ reload 后持久化（嵌入只存引用，.kbnote 序列化无正文副本）；
 *  ⑦ 纯浏览器路径（无 Tauri）功能正常。
 *
 * 注意：page.evaluate 运行在浏览器上下文，构造函数写在内部。
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForFunction(() => window.__drawpaper__ && !!window.__drawpaper__.getState().doc.id);
  await page.waitForTimeout(300);
});

/** 落库 doc_A（被嵌入的目标文档）。 */
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

/** 落库 doc_B（含一个嵌入 doc_A/n_A1 的 note 块）。 */
async function seedSource(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const h = window.__drawpaper__!;
    h.loadFixture({
      format: 'knowledge-block-notes', version: 4, id: 'doc_B', title: '引用画布B',
      board: { createdAt: Date.now(), updatedAt: Date.now() },
      nodes: [{
        id: 'n_BE', type: 'note', x: 0, y: 0, width: 320, height: 160,
        content: {
          format: 'tiptap-json',
          data: { kind: 'doc-embed', targetDocId: 'doc_A', targetNodeId: 'n_A1', titleSnapshot: '目标块' },
        },
        parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {},
      }],
      edges: [], tags: [],
      layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
      viewport: { x: 0, y: 0, zoom: 1 },
      page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: true, colorMode: 'color', header: false, footer: false, showPageNumbers: false, edgeLabels: true, pageBreaks: [] },
      assetRefs: [], links: [],
    } as unknown as Parameters<typeof h.loadFixture>[0]);
    h.invoke('requestSave');
  });
  await page.waitForTimeout(600);
}

test('块嵌入全链路：实时只读视图 / 刷新 / 悬挂 / 导出 caption / 反链 / 持久化', async ({ page }) => {
  // ① 落库 A（目标）与 B（嵌入源）。
  await seedTarget(page, '目标块正文-初版');
  await seedSource(page);

  // B 中嵌入可见：正文来自 A 的实时解析，顶部来源 caption = 目标画布标题。
  const embedBody = page.locator('[data-embed-target]');
  await expect(embedBody).toContainText('目标块正文-初版', { timeout: 3000 });
  await expect(page.locator('[data-embed-source]')).toContainText('目标画布A');

  // 反链索引：嵌入即一条出链；A 侧反链列出 B。
  const links = await page.evaluate(() => window.__drawpaper__!.currentLinks());
  expect(links).toHaveLength(1);
  expect((links[0] as { targetDocId: string }).targetDocId).toBe('doc_A');
  const backlinks = await page.evaluate(() => window.__drawpaper__!.backlinksTo('doc_A', 'n_A1'));
  expect(backlinks).toHaveLength(1);
  expect((backlinks[0] as { sourceDocTitle: string }).sourceDocTitle).toBe('引用画布B');

  // ⑥ 持久化：.kbnote 序列化只带引用（payload 在、正文副本不在）；reload 后仍在。
  const exported = await page.evaluate(() => window.__drawpaper__!.exportCurrent());
  expect(exported).toContain('"kind": "doc-embed"');
  expect(exported).not.toContain('目标块正文-初版');
  await page.reload();
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForFunction(() => window.__drawpaper__ && !!window.__drawpaper__.getState().doc.id);
  await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'doc_B'));
  await page.waitForTimeout(800);
  await expect(page.locator('[data-embed-target]')).toContainText('目标块正文-初版', { timeout: 3000 });

  // ② 改 A 块内容 → 重开 B → 显示新内容。
  await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'doc_A'));
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const h = window.__drawpaper__!;
    h.invoke('updateContent', 'n_A1', {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '目标块正文-改后' }] }],
    });
    h.invoke('requestSave');
  });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'doc_B'));
  await page.waitForTimeout(800);
  await expect(page.locator('[data-embed-target]')).toContainText('目标块正文-改后', { timeout: 3000 });

  // ④ 导出（SVG 矢量路径 = 矢量 PDF 同源）：产物含嵌入正文 + 来源标题 caption。
  const svgs = await page.evaluate(() => window.__drawpaper__!.buildSvgPagesDev());
  const joined = svgs.join('\n');
  expect(joined).toContain('嵌入自「目标画布A」');
  expect(joined).toContain('目标块正文-改后');

  // ③ 删 A 中目标块 → B 显示悬挂占位且不报错。
  await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'doc_A'));
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const h = window.__drawpaper__!;
    h.invoke('deleteNodes', ['n_A1']);
    h.invoke('requestSave');
  });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'doc_B'));
  await page.waitForTimeout(800);
  await expect(page.locator('[data-embed-dangling]')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('[data-embed-dangling]')).toContainText('原块已删除');
  // 悬挂时链接记录保留（不静默丢）。
  const linksAfterDelete = await page.evaluate(() => window.__drawpaper__!.currentLinks());
  expect(linksAfterDelete).toHaveLength(1);
});
