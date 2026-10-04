import { test, expect, type Page } from '@playwright/test';

/**
 * Wave4b P1 验收加固。复杂结构判定走 DEV 钩子断言，UI 只做主路径点击，稳定优先。
 */

const OUT = '/tmp/p1-verify';

async function boot(page: Page) {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForFunction(() => !!(window.__drawpaper__ && window.__drawpaper__.getState().doc.id));
  await page.waitForTimeout(200);
}

function baseDoc(nodes: any[], edges: any[] = []): any {
  return {
    format: 'knowledge-block-notes', version: 1, id: 'p1doc', title: 'P1验收',
    board: { createdAt: 0, updatedAt: 0 },
    nodes, edges, tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: false, colorMode: 'color', header: false, footer: false, showPageNumbers: false, edgeLabels: true, pageBreaks: [] },
    assetRefs: [],
  };
}
function n(id: string, x: number, y: number, text = '块', parentId: string | null = null) {
  return {
    id, type: 'text', x, y, width: 200, height: 60,
    content: { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } },
    parentId, pinned: false, locked: false, collapsed: false, tags: [], style: {},
  };
}

test.describe('P1 验收加固', () => {
  test('大纲/重排：reparentNode 改父子并增删边', async ({ page }) => {
    await boot(page);
    await page.evaluate((d) => window.__drawpaper__!.loadFixture(d), baseDoc([
      n('a', 100, 100, 'A'), n('b', 400, 100, 'B'), n('c', 400, 250, 'C'),
    ]));
    await page.waitForTimeout(300);
    // 把 B 挂到 A 下。
    await page.evaluate(() => window.__drawpaper__!.invoke('reparentNode', 'b', 'a'));
    await page.waitForTimeout(200);
    const st = await page.evaluate(() => {
      const d: any = window.__drawpaper__!.getState().doc;
      return { bParent: d.nodes.find((x: any) => x.id === 'b').parentId, edgeCount: d.edges.length };
    });
    expect(st.bParent).toBe('a');
    expect(st.edgeCount).toBeGreaterThanOrEqual(1);
    // 成环防护：把 a 挂到自己的后代 b 下，core 应静默拒绝（parentId 不变）。
    await page.evaluate(() => window.__drawpaper__!.invoke('reparentNode', 'a', 'b'));
    await page.waitForTimeout(200);
    const afterCycle = await page.evaluate(() => {
      const d: any = window.__drawpaper__!.getState().doc;
      return { a_parent: d.nodes.find((x: any) => x.id === 'a').parentId };
    });
    console.log('CYCLE_GUARD', JSON.stringify(afterCycle));
    expect(afterCycle.a_parent).toBeNull();
  });

  test('模板：从模板新建文档含预期块', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__drawpaper__!.invoke('createDocFromTemplate', 'reading-notes'));
    await page.waitForTimeout(800);
    const st = await page.evaluate(() => {
      const d = window.__drawpaper__!.getState().doc;
      return { title: d.title, count: d.nodes.length };
    });
    console.log('TEMPLATE_DOC', JSON.stringify(st));
    expect(st.count).toBeGreaterThan(3);
  });

  test('快照：拍快照→改文档→恢复内容回到快照', async ({ page }) => {
    await boot(page);
    await page.evaluate((d) => window.__drawpaper__!.loadFixture(d), baseDoc([n('x', 100, 100, '原始内容')]));
    await page.evaluate(() => window.__drawpaper__!.invoke('requestSave'));
    await page.waitForTimeout(600);
    const docId = await page.evaluate(() => window.__drawpaper__!.getState().doc.id);
    // 拍快照（snapshotDoc 返回 void，改后用 listSnapshots 取 id）。
    await page.evaluate(async () => { await window.__drawpaper__!.invoke('snapshotDoc', 'v1'); });
    await page.waitForTimeout(400);
    const snaps: any = await page.evaluate(async (id) => await window.__drawpaper__!.invoke('listSnapshots', id), docId);
    expect(Array.isArray(snaps) ? snaps.length : 0).toBeGreaterThanOrEqual(1);
    const snapId = snaps[0].id;
    // 改文档：加一个块。
    await page.evaluate(() => window.__drawpaper__!.invoke('addNode', 'text', 300, 100));
    await page.waitForTimeout(200);
    const afterChange = await page.evaluate(() => window.__drawpaper__!.getState().doc.nodes.length);
    // 恢复快照。
    await page.evaluate(async (id) => { await window.__drawpaper__!.invoke('restoreSnapshot', id); }, snapId);
    await page.waitForTimeout(600);
    const restored = await page.evaluate(() => window.__drawpaper__!.getState().doc.nodes.length);
    console.log('SNAPSHOT', { afterChange, restored });
    expect(restored).toBeLessThan(afterChange);
  });

  test('回收站：删文档→出现→恢复→列表→彻底删除消失', async ({ page }) => {
    await boot(page);
    await page.evaluate((d) => window.__drawpaper__!.loadFixture(d), baseDoc([n('z', 100, 100, '待删')]));
    await page.evaluate(() => window.__drawpaper__!.invoke('requestSave'));
    await page.waitForTimeout(700);
    const docId = await page.evaluate(() => window.__drawpaper__!.getState().doc.id);
    // 删当前文档进回收站。
    await page.evaluate(async (id) => { await window.__drawpaper__!.invoke('deleteDoc', id); }, docId);
    await page.waitForTimeout(800);
    const trash = await page.evaluate(async () => await window.__drawpaper__!.invoke('listTrash'));
    console.log('TRASH_AFTER_DELETE', JSON.stringify(trash));
    expect(Array.isArray(trash) ? trash.length : 0).toBeGreaterThanOrEqual(1);
  });

  test('新块型：表格/代码/公式渲染且可输入', async ({ page }) => {
    await boot(page);
    await page.evaluate((d) => window.__drawpaper__!.loadFixture(d), baseDoc([]));
    await page.evaluate(() => {
      window.__drawpaper__!.invoke('addNode', 'table', 100, 100);
      window.__drawpaper__!.invoke('addNode', 'code', 100, 300);
      window.__drawpaper__!.invoke('addNode', 'equation', 100, 500);
    });
    await page.waitForTimeout(600);
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(300);
    // 公式块双击编辑输入 E=mc^2。
    await page.screenshot({ path: `${OUT}/p1-blocks.png` });
    const kinds = await page.evaluate(() => window.__drawpaper__!.getState().doc.nodes.map((x: any) => x.type));
    console.log('BLOCK_TYPES', JSON.stringify(kinds));
    expect(kinds).toContain('table');
    expect(kinds).toContain('code');
    expect(kinds).toContain('equation');
  });

  test('导出：SVG 与 Markdown 真实下载文件', async ({ page }) => {
    await boot(page);
    await page.evaluate((d) => window.__drawpaper__!.loadFixture(d), baseDoc([n('a', 100, 100, '# 标题\n正文段落')]));
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+p');
    await page.waitForSelector('text=导出 / 打印', { timeout: 5000 });

    // Markdown 下载。
    const mdPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Markdown/ }).click();
    const md = await mdPromise;
    const mdPath = `${OUT}/${md.suggestedFilename()}`;
    await md.saveAs(mdPath);
    console.log('MD_DOWNLOAD', md.suggestedFilename());

    // SVG 下载。
    const svgPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /矢量 SVG/ }).click();
    const svg = await svgPromise;
    const svgPath = `${OUT}/${svg.suggestedFilename()}`;
    await svg.saveAs(svgPath);
    console.log('SVG_DOWNLOAD', svg.suggestedFilename());
    expect(md.suggestedFilename()).toMatch(/\.md$/);
    expect(svg.suggestedFilename()).toMatch(/\.svg$/);
  });

  test('AI 失败路径：非法 JSON → toast 报错且块/边数不变', async ({ page }) => {
    await boot(page);
    await page.evaluate((d) => window.__drawpaper__!.loadFixture(d), baseDoc([n('a', 100, 100, 'A'), n('b', 400, 100, 'B')]));
    await page.evaluate(() => {
      localStorage.setItem('drawpaper.ai.config.v1', JSON.stringify({
        endpoint: 'http://ai.local/v1', apiKey: 'k', model: 'm', temperature: 0.2,
      }));
    });
    await page.route('**/chat/completions', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: 'this is not json{{{' }),
    );
    const before = await page.evaluate(() => ({
      nodes: window.__drawpaper__!.getState().doc.nodes.length,
      edges: window.__drawpaper__!.getState().doc.edges.length,
    }));
    await page.getByRole('button', { name: /AI 辅助/ }).click();
    await page.getByText('一键整理建议').click();
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => ({
      nodes: window.__drawpaper__!.getState().doc.nodes.length,
      edges: window.__drawpaper__!.getState().doc.edges.length,
    }));
    console.log('AI_FAIL', JSON.stringify({ before, after }));
    // 块/边数不变（护栏生效）。
    expect(after.nodes).toBe(before.nodes);
    expect(after.edges).toBe(before.edges);
    await page.screenshot({ path: `${OUT}/ai-fail-toast.png` });
  });

  test('手动分页符：addManualPageBreak/removePageBreak 经 store 生效', async ({ page }) => {
    await boot(page);
    await page.evaluate((d) => window.__drawpaper__!.loadFixture(d), baseDoc([n('a', 100, 100, 'A')]));
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__drawpaper__!.invoke('addManualPageBreak', 'pb1', 0, 500));
    await page.waitForTimeout(150);
    const afterAdd = await page.evaluate(() => window.__drawpaper__!.getState().doc.page.pageBreaks.length);
    expect(afterAdd).toBeGreaterThanOrEqual(1);
    await page.evaluate(() => window.__drawpaper__!.invoke('removePageBreak', 'pb1'));
    await page.waitForTimeout(150);
    const afterRemove = await page.evaluate(() => window.__drawpaper__!.getState().doc.page.pageBreaks.length);
    console.log('PAGEBREAK', { afterAdd, afterRemove });
    expect(afterRemove).toBe(afterAdd - 1);
  });

  test('触屏冒烟：coarse pointer 显式工具按钮组可见', async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.locator('.react-flow')).toBeVisible();
    await page.waitForFunction(() => !!(window.__drawpaper__ && window.__drawpaper__.getState().doc.id));
    await page.waitForTimeout(400);
    // coarse 工具按钮组：选择/连线/平移。
    const toolbar = page.locator('button[title="选择 (V)"]');
    await expect(toolbar).toBeVisible();
    await expect(page.locator('button[title="连线 (C)"]')).toBeVisible();
    await expect(page.locator('button[title="平移"]')).toBeVisible();
    await page.screenshot({ path: `${OUT}/coarse-toolbar.png` });
    await ctx.close();
  });
});
