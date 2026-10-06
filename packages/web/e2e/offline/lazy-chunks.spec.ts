import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  bootOnlineWithSW,
  goOfflineAndReload,
  newTextBlock,
  pickSlashItem,
  openExportDialog,
  attachRequestAudit,
} from './helpers';

/**
 * 用例 2：懒加载 chunk 断网可用（运行时真实路径）。
 *  联网只建一个普通文本块（不碰任何懒 chunk）；断网后：
 *   - 导出对话框 PNG / PDF 按钮：动态 import html-to-image / pdf-lib（precache 命中）；
 *   - 首次插入并渲染公式块：katex JS chunk + 字体 CSS；
 *   - 首次插入代码块：highlight.js 语法 chunk；
 *  全程无失败请求、无外网请求。
 */

const OUT = path.resolve(process.cwd(), 'test-results/offline');

test.describe('离线：懒加载 chunk 断网可用', () => {
  test('导出 PNG/PDF + 公式块 + 代码块 全部断网可用', async ({ page, context }) => {
    fs.mkdirSync(OUT, { recursive: true });
    const audit = attachRequestAudit(page);

    // ---- 联网：仅建一个普通文本块（触发 tiptap 主 chunk，不碰懒 chunk）----
    await bootOnlineWithSW(page);
    await newTextBlock(page, 300, 250);
    await page.keyboard.type('断网懒加载验证', { delay: 10 });
    await page.locator('.react-flow__pane').click({ position: { x: 800, y: 500 } });
    await page.waitForTimeout(1200); // 等自动保存落盘

    // ---- 断网 ----
    await goOfflineAndReload(context, page);
    await page.getByText('断网懒加载验证').first().waitFor();

    // ---- 导出对话框：PNG（html-to-image chunk）----
    await openExportDialog(page);
    page.on('download', async (d) => {
      try {
        await d.saveAs(path.join(OUT, `offline-${d.suggestedFilename()}`));
      } catch {
        /* 已存过 */
      }
    });

    const [png] = await Promise.all([
      page.waitForEvent('download', { timeout: 90_000, predicate: (d) => d.suggestedFilename().endsWith('.png') }),
      page.getByRole('button', { name: /导出高清 PNG/ }).click(),
    ]);
    const pngPath = path.join(OUT, `offline-${png.suggestedFilename()}`);
    await png.saveAs(pngPath);
    const pngSize = fs.statSync(pngPath).size;
    console.log('OFFLINE_PNG_DOWNLOAD', png.suggestedFilename(), pngSize);
    expect(pngSize).toBeGreaterThan(5_000);

    // 多页 PNG 逐页 rasterize 排水，再点 PDF。
    await page.waitForTimeout(2500);

    // ---- 导出 PDF（pdf-lib chunk）----
    const pdfPromise = page.waitForEvent('download', {
      timeout: 90_000,
      predicate: (d) => d.suggestedFilename().endsWith('.pdf'),
    });
    await page.getByRole('button', { name: /直接下载 PDF/ }).click();
    const pdf = await pdfPromise;
    const pdfPath = path.join(OUT, `offline-${pdf.suggestedFilename()}`);
    await pdf.saveAs(pdfPath);
    const pdfSize = fs.statSync(pdfPath).size;
    console.log('OFFLINE_PDF_DOWNLOAD', pdf.suggestedFilename(), pdfSize);
    expect(pdfSize).toBeGreaterThan(5_000);

    // 关掉导出对话框。
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // ---- 断网首次插入公式块（katex chunk + CSS）----
    await newTextBlock(page, 300, 450);
    await pickSlashItem(page, '数学公式');
    await page.waitForTimeout(400);
    await page.locator('.react-flow__node').last().dblclick();
    const ta = page.locator('textarea[placeholder*="E = mc"]');
    await ta.waitFor({ timeout: 5_000 });
    await ta.fill('\\int_0^1 x^2\\,dx = \\frac{1}{3}');
    await page.locator('.react-flow__pane').click({ position: { x: 900, y: 600 } });
    await page.locator('.katex').first().waitFor({ timeout: 20_000 });
    console.log('OFFLINE_KATEX_RENDERED', await page.locator('.katex').count());

    // ---- 断网首次插入代码块（highlight-data chunk）----
    await newTextBlock(page, 300, 650);
    await pickSlashItem(page, '代码块');
    await page.waitForFunction(() => document.querySelectorAll('.hljs').length > 0, null, { timeout: 20_000 });
    const hljsClass = await page.locator('.hljs').first().getAttribute('class');
    console.log('OFFLINE_HIGHLIGHT_CHUNK', hljsClass);

    await page.screenshot({ path: path.join(OUT, 'lazy-chunks-offline.png') });

    // 双重断言：请求层面无失败、无外网（chunk 全部 precache 命中）。
    audit.assertClean(page.url().replace(/\/$/, ''));
  });
});
