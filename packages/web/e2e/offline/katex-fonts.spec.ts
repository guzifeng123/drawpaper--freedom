import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  bootOnlineWithSW,
  goOfflineAndReload,
  newTextBlock,
  pickSlashItem,
  attachRequestAudit,
} from './helpers';

/**
 * 用例 3：KaTeX 字体断网可用。
 *  断网下首次渲染公式块 → katex CSS 引用的 KaTeX_*.woff2/ttf 字体请求
 *  必须由 SW precache 命中（无 failed request）、字形实际渲染。
 */

const OUT = path.resolve(process.cwd(), 'test-results/offline');

test.describe('离线：KaTeX 字体 precache 命中', () => {
  test('公式渲染后字体请求零失败、字形实际绘制', async ({ page, context }) => {
    fs.mkdirSync(OUT, { recursive: true });
    const audit = attachRequestAudit(page);

    await bootOnlineWithSW(page);
    await goOfflineAndReload(context, page);

    // 断网下插入公式块并给源码。
    await newTextBlock(page, 300, 300);
    await pickSlashItem(page, '数学公式');
    await page.waitForTimeout(400);
    await page.locator('.react-flow__node').last().dblclick();
    const ta = page.locator('textarea[placeholder*="E = mc"]');
    await ta.waitFor({ timeout: 5_000 });
    await ta.fill('\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}');
    await page.locator('.react-flow__pane').click({ position: { x: 900, y: 600 } });

    // 等 katex 渲染 + 字体加载。
    await page.locator('.katex').first().waitFor({ timeout: 20_000 });
    await page.waitForFunction(async () => {
      // KaTeX_Main 字体被浏览器实际加载（@font-face 命中 precache 后 resolve）。
      try {
        return document.fonts.check('16px KaTeX_Main');
      } catch {
        return false;
      }
    }, null, { timeout: 15_000 });

    const fontReqs = audit.urls.filter((u) => /\.(woff2?|ttf)(\?|$)/.test(u));
    const fontFailures = fontReqs.filter((u) => audit.failures.has(u));
    console.log('KATEX_FONT_REQUESTS', fontReqs.length, fontReqs.slice(0, 5));
    console.log('KATEX_FONT_FAILURES', fontFailures.length);
    expect(fontReqs.length).toBeGreaterThan(0);
    expect(fontFailures).toHaveLength(0);

    // 字形实际渲染：.katex 容器有尺寸、含 mathml/annotation。
    const box = await page.locator('.katex').first().boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(10);
    expect(await page.locator('.katex annotation, .katex .mord, .katex .msupsub').count()).toBeGreaterThan(0);

    await page.locator('.equation-html').first().screenshot({ path: path.join(OUT, 'katex-glyph-offline.png') });
    audit.assertClean(page.url().replace(/\/$/, ''));
  });
});
