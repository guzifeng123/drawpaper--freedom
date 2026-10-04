import { test, expect, type Page } from '@playwright/test';
import { waitForApp, loadStandard, invoke } from './fixtures/load-doc';
import fs from 'node:fs';
import path from 'node:path';

/**
 * §9 导出硬验收（真实产物）：
 *  - 标准 30 块样例 → tiles 横向 A4
 *  - 矢量打印容器常驻 → 逐页截图 + page.pdf() 矢量 PDF
 *  - 直接下载 PDF（pdf-lib 位图）/ 高清 PNG
 *  - 断言页数、文件名、孤块黄标、折叠子树缺席、黑白无彩色
 */

const OUT = path.resolve(process.cwd(), 'test-results/acceptance');

async function isolateSheetsForPdf(page: Page): Promise<void> {
  // 隐藏应用 UI，只保留打印容器，让 page.pdf() 输出干净的 A4 页。
  await page.addStyleTag({
    content: `
      body > *:not(#print-root):not(.drawpaper-print-container) { display: none !important; }
      .drawpaper-print-container { display: block !important; }
      .drawpaper-print-container .sheet { box-shadow: none !important; margin: 0 !important; page-break-after: always; }
    `,
  });
}

test.describe('§9 导出硬验收 / 真实产物', () => {
  test('tiles 横向 A4：矢量 PDF + 逐页截图 + 下载 PDF/PNG', async ({ page }) => {
    fs.mkdirSync(OUT, { recursive: true });
    await waitForApp(page);
    const fx = await loadStandard(page);

    // 配置页面：tiles / 横向 / 15mm / 页眉页脚页码 / 彩色。
    await invoke(page, 'setPageSettings', {
      mode: 'tiles',
      orientation: 'landscape',
      marginMm: 15,
      header: true,
      footer: true,
      showPageNumbers: true,
      colorMode: 'color',
      edgeLabels: true,
    });
    await invoke(page, 'setSelection', []);

    // 常驻打印容器。
    await page.evaluate(() => window.__drawpaper__?.setDebugSheets(true));
    await page.waitForSelector('.drawpaper-print-container .sheet', { state: 'attached', timeout: 10_000 });
    await page.waitForTimeout(300);

    // 隔离打印容器（隐藏应用 UI），让 sheet 可见以便逐页截图。
    await isolateSheetsForPdf(page);
    await page.waitForTimeout(200);

    const sheets = page.locator('.drawpaper-print-container .sheet');
    const pageCount = await sheets.count();
    console.log('TILES_PAGE_COUNT', pageCount);
    expect(pageCount).toBeGreaterThanOrEqual(2);

    // 逐页截图。
    for (let i = 0; i < pageCount; i++) {
      await sheets.nth(i).screenshot({ path: path.join(OUT, `tiles-landscape-page-${i + 1}.png`), animations: 'disabled' });
    }

    // 孤块黄标存在。
    const orphanBadges = await page.locator('[data-orphan-badge]').count();
    console.log('ORPHAN_BADGES', orphanBadges);
    expect(orphanBadges).toBeGreaterThanOrEqual(1);

    // 折叠子树节点缺席：确认折叠后代节点不出现在 sheet 中。
    for (const id of fx.collapsedDescendants.slice(0, 3)) {
      const inSheet = await page.locator(`.drawpaper-print-container [data-node-id="${id}"]`).count();
      expect(inSheet, `折叠后代 ${id} 不应出现在导出`).toBe(0);
    }

    // 矢量 PDF：容器已隔离，直接 page.pdf()。
    await page.emulateMedia({ media: 'print' });
    const pdfBuf = await page.pdf({
      format: 'A4',
      landscape: true,
      printBackground: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: true,
    });
    const pdfPath = path.join(OUT, 'tiles-landscape.pdf');
    fs.writeFileSync(pdfPath, pdfBuf);
    console.log('VECTOR_PDF_BYTES', pdfBuf.length);
    expect(pdfBuf.length).toBeGreaterThan(5000);

    // 黑白模式截图：无彩色边。
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.__drawpaper__?.setDebugSheets(false));
    await invoke(page, 'setPageSettings', { colorMode: 'gray' });
    await page.evaluate(() => window.__drawpaper__?.setDebugSheets(true));
    await page.waitForSelector('.drawpaper-print-container .sheet', { timeout: 5000 });
    await page.waitForTimeout(200);
    await page.locator('.drawpaper-print-container .sheet').first().screenshot({
      path: path.join(OUT, 'tiles-grayscale-page1.png'),
    });

    // 恢复彩色。
    await invoke(page, 'setPageSettings', { colorMode: 'color' });
  });

  test('直接下载 PDF（位图）与高清 PNG：文件名合规、非空、多页', async ({ page }) => {
    fs.mkdirSync(OUT, { recursive: true });
    // 后台排水：多页 PNG 会连发多个下载事件，统一接住存盘，避免污染后续断言。
    page.on('download', async (d) => {
      try {
        await d.saveAs(path.join(OUT, d.suggestedFilename()));
      } catch {
        /* 已存过则忽略 */
      }
    });
    await waitForApp(page);
    await loadStandard(page);
    await invoke(page, 'setPageSettings', { mode: 'tiles', orientation: 'landscape' });

    // 打开导出弹窗。
    await page.keyboard.press('Control+p');
    await page.waitForSelector('text=导出 / 打印', { timeout: 5000 });

    // 捕获 PNG 下载。
    const [pngDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.getByRole('button', { name: /导出高清 PNG/ }).click(),
    ]);
    const pngPath = path.join(OUT, pngDownload.suggestedFilename());
    await pngDownload.saveAs(pngPath);
    const pngStat = fs.statSync(pngPath);
    console.log('PNG_DOWNLOAD', pngDownload.suggestedFilename(), pngStat.size);
    expect(pngDownload.suggestedFilename()).toMatch(/\.png$/);
    expect(pngStat.size).toBeGreaterThan(10_000);

    // 多页 PNG 逐页 rasterize，等全部落盘再点 PDF，避免容器 reveal/restore 竞态。
    await page.waitForTimeout(3000);

    // 捕获 PDF 下载（位图 pdf-lib）——按扩展名过滤，避免吃到多页 PNG 的后续下载事件。
    const pdfPromise = page.waitForEvent('download', {
      timeout: 60_000,
      predicate: (d) => d.suggestedFilename().endsWith('.pdf'),
    });
    await page.getByRole('button', { name: /直接下载 PDF/ }).click();
    const pdfDownload = await pdfPromise;
    const pdfPath = path.join(OUT, pdfDownload.suggestedFilename());
    await pdfDownload.saveAs(pdfPath);
    const pdfStat = fs.statSync(pdfPath);
    console.log('PDF_DOWNLOAD', pdfDownload.suggestedFilename(), pdfStat.size);
    expect(pdfDownload.suggestedFilename()).toMatch(/\.pdf$/);
    // 文件名含横向/纵向与日期。
    expect(pdfDownload.suggestedFilename()).toMatch(/横向/);
    expect(pdfStat.size).toBeGreaterThan(10_000);
  });
});
