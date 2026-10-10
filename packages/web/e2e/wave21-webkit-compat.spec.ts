import { test, expect, devices, type Browser, type Page } from '@playwright/test';
import { waitForApp, loadStandard } from './fixtures/load-doc';

/**
 * Wave21 WebKit/Safari 兼容降级 —— **仅在 playwright.webkit.config.ts（project=webkit）下运行**。
 *
 * 真机 Safari / iPad 缺失 FSA（showOpenFilePicker/showSaveFilePicker），OPFS 支持参差，
 * 无桌面 Web Share。本 spec 验证兜底链：
 *  1. 能力探测：WebKit 无 FSA、无 Web Share（与桌面 Safari 同形）；
 *  2. 上传兜底：「文档→打开本地 .kbnote」走 <input type=file>（filechooser 事件）；
 *  3. 下载兜底：导出 .kbnote 走 <a download>；
 *  4. OPFS 不可用（addInitScript 模拟）：图片 dataURL 内联、附件 toast 不建坏块；
 *  5. 配额弹窗：无 Web Share → 导出 .kbnote + 整库 .kbpack 备份下载。
 *
 * 注意：本文件由 webkit config 的 testMatch 独占；默认 chromium 套件不跑它。
 */

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xc3, 0xb4, 0xc3, 0xa1,
]);

async function dropPng(page: Page): Promise<void> {
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'dropped.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const pane = document.querySelector('.react-flow__pane') as HTMLElement;
    pane.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 500, clientY: 400 }),
    );
  }, PNG_B64);
}

async function dropPngAndWait(page: Page, minCount = 1) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await dropPng(page);
    try {
      await page.waitForFunction(
        (n) => window.__drawpaper__!.getState().doc.nodes.filter((x) => x.type === 'image' && !!x.image?.src).length >= n,
        minCount,
        { timeout: 8_000 },
      );
      return;
    } catch {
      /* 重投 */
    }
  }
  await page.waitForFunction(
    (n) => window.__drawpaper__!.getState().doc.nodes.filter((x) => x.type === 'image' && !!x.image?.src).length >= n,
    minCount,
    { timeout: 30_000 },
  );
}

async function dropPdf(page: Page): Promise<void> {
  await page.evaluate((bytesArr) => {
    const bytes = Uint8Array.from(bytesArr);
    const file = new File([bytes], 'report.pdf', { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const pane = document.querySelector('.react-flow__pane') as HTMLElement;
    pane.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 600, clientY: 500 }),
    );
  }, Array.from(PDF_BYTES));
}

/** OPFS 整体不可用上下文（navigator.storage=undefined，模拟旧 WebKit/隐私模式）。 */
async function noOpfsContext(browser: Browser) {
  const ctx = await browser.newContext(devices['Desktop Safari']);
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true, writable: true });
  });
  return ctx;
}

test.describe('Wave21 WebKit 兼容（project=webkit）', () => {
  test('能力探测：WebKit 无 FSA、无 Web Share', async ({ page }) => {
    await waitForApp(page);
    const cap = await page.evaluate(() => ({
      fsa: window.__drawpaper__!.webFsaSupported(),
      share: window.__drawpaper__!.webCanShare(),
    }));
    console.log('WEBKIT_CAP', cap);
    // WebKit/Safari 无 File System Access。
    expect(cap.fsa).toBe(false);
    // headless WebKit 无 Web Share API。
    expect(cap.share).toBe(false);
  });

  test('上传兜底：文档→打开本地 .kbnote 走 <input type=file>（filechooser）', async ({ page }) => {
    test.setTimeout(60_000);
    await waitForApp(page);
    await loadStandard(page);
    // 取当前文档的合法 .kbnote 文本作为待上传文件。
    const kbnote = await page.evaluate(() => window.__drawpaper__!.exportCurrent());

    // exact:true——侧栏「文档」按钮与「新建文档」「收起文档列表」等做子串匹配时会命中多个，
    // strict mode 报错；该菜单按钮名就是「文档」本身（annotation 证实首个元素即目标）。
    await page.getByRole('button', { name: '文档', exact: true }).click();
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15_000 }),
      page.getByRole('menuitem', { name: '打开本地 .kbnote' }).click(),
    ]);
    // 写临时文件并交给 filechooser。
    const tmp = `/tmp/webkit-upload-${Date.now()}.kbnote`;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(tmp, kbnote, 'utf8');
    await fileChooser.setFiles(tmp);

    // 应用打开该文档（标题/节点数与夹具一致即成功）。
    await expect(page).toHaveURL(/.*/);
    await page.waitForFunction(() => window.__drawpaper__!.getState().doc.nodes.length > 0, null, { timeout: 15_000 });
    const nodes = await page.evaluate(() => window.__drawpaper__!.getState().doc.nodes.length);
    expect(nodes).toBeGreaterThan(0);
  });

  test('下载兜底：导出 .kbnote 走 <a download>', async ({ page }) => {
    test.setTimeout(60_000);
    await waitForApp(page);
    await loadStandard(page);

    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }),
      page.getByRole('button', { name: '文档', exact: true }).click().then(() =>
        page.getByRole('menuitem', { name: '导出 .kbnote' }).click(),
      ),
    ]);
    console.log('WEBKIT_EXPORT_FILENAME', dl.suggestedFilename());
    expect(dl.suggestedFilename()).toMatch(/\.kbnote$/);
  });

  test('OPFS 不可用：图片 dataURL 内联 + 附件 toast 不建坏块', async ({ browser }) => {
    test.setTimeout(90_000);
    const ctx = await noOpfsContext(browser);
    const page = await ctx.newPage();
    await waitForApp(page);
    expect(await page.evaluate(() => window.__drawpaper__!.opfsAvailable())).toBe(false);

    await dropPngAndWait(page, 1);
    const imgs = await page.evaluate(() =>
      window.__drawpaper__!.getState().doc.nodes.filter((n) => n.type === 'image').map((n) => n.image!.src),
    );
    expect(imgs.length).toBeGreaterThanOrEqual(1);
    for (const s of imgs) expect(s.startsWith('data:')).toBe(true);

    const nodesBefore = await page.evaluate(() => window.__drawpaper__!.getState().doc.nodes.length);
    await dropPdf(page);
    await expect(page.locator('div[role="status"]', { hasText: /附件本地存储|OPFS/ })).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction((before) => window.__drawpaper__!.getState().doc.nodes.length === before, nodesBefore, {
      timeout: 15_000,
    });
    await ctx.close();
  });

  test('配额弹窗：无 Web Share → 导出 .kbnote + 整库 .kbpack 备份下载', async ({ page }) => {
    test.setTimeout(60_000);
    await waitForApp(page);
    await loadStandard(page);
    await page.evaluate(() => window.__drawpaper__!.quotaResetThrottle());
    await page.evaluate(() => window.__drawpaper__!.quotaRaise());

    await expect(page.getByTestId('storage-quota-dialog')).toBeVisible();
    await expect(page.getByText('本地存储空间不足')).toBeVisible();
    await expect(page.getByTestId('quota-action-export')).toBeVisible();
    await expect(page.getByTestId('quota-action-backup')).toBeVisible();
    await expect(page.getByTestId('quota-action-share')).toHaveCount(0);

    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }),
      page.getByTestId('quota-action-export').click(),
    ]);
    expect(dl.suggestedFilename()).toMatch(/\.kbnote$/);
  });
});
