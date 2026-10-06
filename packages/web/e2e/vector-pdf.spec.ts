import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BlockNode, KBNoteDoc } from '@drawpaper/core';
import { buildStandardFixture } from './fixtures/sample-doc';
import { waitForApp, invoke } from './fixtures/load-doc';

/**
 * Wave14·矢量 PDF 直下载硬验收（真实产物 + poppler 实测）：
 *  - 矢量主线：buildPagesSvg（与 .svg 导出同源）→ svg2pdf → jsPDF 多页矢量 PDF；
 *  - pdffonts：嵌入的 CID TrueType（CJK）字体 emb=yes / uni=yes；
 *  - pdftotext：能抽出画布里的中文 + 英文正文（文本对象可选可复制，非整页栅格）；
 *  - 页数与分页预览（.sheet 数）一致；
 *  - 图片块在 PDF 中以光栅 image XObject 可见（pdfimages -list）；
 *  - 强制矢量失败 → toast「矢量导出失败，已回退位图模式」且仍产出 PDF。
 */

const OUT = path.resolve(process.cwd(), 'test-results/vector-pdf');
/** 1x1 红 PNG，图片块 data: 内嵌。 */
const RED_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function tipDoc(text: string) {
  return {
    format: 'tiptap-json' as const,
    data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  };
}

/** 标准夹具基础上：追加一个图片块孤块（data: PNG），验证图片光栅嵌入。 */
function buildVectorDoc(): { doc: KBNoteDoc } {
  const { doc } = buildStandardFixture('矢量PDF验收');

  // 追加一个图片块（孤块，正坐标）。block.image.src 为 data: PNG，svg-export 内联为 <image>。
  const imgNode = {
    id: 'v_img_probe',
    type: 'image',
    x: 2600, y: 600,
    width: 160, height: 120,
    content: tipDoc('图片块'),
    image: { src: RED_PNG, alt: '测试图' },
    parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {},
  } as unknown as BlockNode;
  if (!process.env.VECTOR_NO_IMG) doc.nodes.push(imgNode);

  return { doc };
}

function sh(args: string[]): string {
  try {
    return execFileSync(args[0]!, args.slice(1), { encoding: 'utf8' });
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? '';
  }
}

async function loadVectorDoc(page: Page, doc: KBNoteDoc): Promise<void> {
  await page.evaluate((d: KBNoteDoc) => {
    (window as unknown as { __drawpaper__: { loadFixture: (x: KBNoteDoc) => void } })
      .__drawpaper__.loadFixture(d);
  }, doc);
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+0');
  await page.waitForTimeout(400);
}

test.describe('Wave14 矢量 PDF 直下载', () => {
  test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

  test('下载矢量 PDF：字体已嵌入、中英文正文可抽取、页数与预览一致、图片可见', async ({ page }) => {
    await waitForApp(page);
    const { doc } = buildVectorDoc();
    await loadVectorDoc(page, doc);
    await invoke(page, 'setPageSettings', {
      mode: 'tiles', orientation: 'portrait', marginMm: 15,
      header: true, footer: true, showPageNumbers: true, colorMode: 'color', edgeLabels: true,
    });
    await invoke(page, 'setSelection', []);

    // 常驻打印容器。
    await page.evaluate(() => window.__drawpaper__?.setDebugSheets(true));
    // setDebugSheets 只翻 window 标志，需一次 store 写入触发 React 重渲染才挂载容器。
    await invoke(page, 'setPageSettings', { colorMode: 'color' });
    await page.waitForSelector('.drawpaper-print-container .sheet', { state: 'attached', timeout: 10_000 });
    await page.waitForTimeout(300);
    const previewPages = await page.locator('.drawpaper-print-container .sheet').count();
    expect(previewPages).toBeGreaterThanOrEqual(1);

    const pdfPromise = page.waitForEvent('download', {
      timeout: 60_000,
      predicate: (d) => d.suggestedFilename().endsWith('.pdf'),
    });
    await page.keyboard.press('Control+p');
    await page.waitForSelector('text=导出 / 打印', { timeout: 5000 });
    await page.getByRole('button', { name: /直接下载 PDF/ }).click();

    const download = await pdfPromise;
    const pdfPath = path.join(OUT, 'vector-direct.pdf');
    await download.saveAs(pdfPath);
    const stat = fs.statSync(pdfPath);
    console.log('VECTOR_PDF_BYTES', stat.size);
    expect(stat.size).toBeGreaterThan(5_000);

    const fontOut = sh(['pdffonts', pdfPath]);
    const textOut = sh(['pdftotext', pdfPath, '-']);
    const infoOut = sh(['pdfinfo', pdfPath]);
    const imgOut = sh(['pdfimages', '-list', pdfPath]);
    console.log('=== pdffonts ===\n' + fontOut);
    console.log('=== pdftotext ===\n' + textOut);
    console.log('=== pdfimages -list ===\n' + imgOut);

    // 字体已嵌入：VecCJK 为 emb=yes（嵌入）+ uni=yes（可抽取）的 CID TrueType。
    expect(fontOut).toMatch(/CID TrueType/);
    expect(fontOut).toMatch(/VecCJK\s+CID TrueType\s+Identity-H\s+yes/);

    // 文本层可抽取：中文孤块节点 + 英文节点正文（节点文本为 blockType#N 形式）。
    expect(textOut).toContain('孤块-无连接');
    expect(textOut).toMatch(/(bullet|todo|note|heading|text)#\d+/);

    // 页数与分页预览一致。
    const m = infoOut.match(/Pages:\s+(\d+)/);
    expect(m, `pdfinfo:\n${infoOut}`).not.toBeNull();
    expect(Number(m![1])).toBe(previewPages);

    // 图片块光栅可见。
    expect(imgOut).toMatch(/image\s+/i);
  });

  test('矢量失败自动回退位图：toast 出现且仍产出 PDF', async ({ page }) => {
    await waitForApp(page);
    const { doc } = buildVectorDoc();
    await loadVectorDoc(page, doc);
    await invoke(page, 'setPageSettings', { mode: 'tiles', orientation: 'portrait' });
    await invoke(page, 'setSelection', []);

    await page.evaluate(() => {
      (window as unknown as { __drawpaper__: { __forceVectorPdfFail__: boolean } })
        .__drawpaper__.__forceVectorPdfFail__ = true;
    });

    const pdfPromise = page.waitForEvent('download', {
      timeout: 60_000,
      predicate: (d) => d.suggestedFilename().endsWith('.pdf'),
    });
    await page.keyboard.press('Control+p');
    await page.waitForSelector('text=导出 / 打印', { timeout: 5000 });
    await page.getByRole('button', { name: /直接下载 PDF/ }).click();

    await expect(
      page.locator('div[role="status"]', { hasText: '矢量导出失败，已回退位图模式' }),
    ).toBeVisible({ timeout: 15_000 });

    const download = await pdfPromise;
    const pdfPath = path.join(OUT, 'vector-fallback.pdf');
    await download.saveAs(pdfPath);
    expect(fs.statSync(pdfPath).size).toBeGreaterThan(5_000);

    await page.evaluate(() => {
      (window as unknown as { __drawpaper__: { __forceVectorPdfFail__: boolean } })
        .__drawpaper__.__forceVectorPdfFail__ = false;
    });
  });
});
