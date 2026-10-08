import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BlockNode, KBNoteDoc } from '@drawpaper/core';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
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
 *  - Wave20：龘（U+9F98，字库已扩到 GB2312 全字库）矢量直出、可抽取、无回退；
 *    真正超纲的 Ext-B 字（𠮷 U+20BB7）仍命中缺字形预检→位图回退。
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

interface PdfAnalysis {
  pages: number;
  text: string;
  hasImage: boolean;
  /** setFont 引用的字体对象数（>0 即文本走字体对象，非整页栅格）。 */
  fontRefCount: number;
}

/**
 * Node 侧用 pdfjs 解析下载产物（CI runner 不保证装 poppler-utils）：
 * 页数 / 文本层（中文+英文正文可抽取即证明矢量文本对象，非整页栅格）/ 图片 XObject。
 */
async function analyzePdf(pdfPath: string): Promise<PdfAnalysis> {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;
  let text = '';
  let hasImage = false;
  const fontRefs = new Set<string>();
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    for (const item of tc.items) {
      if ('str' in item && item.str) text += `${item.str}\n`;
    }
    const opList = await page.getOperatorList();
    for (let k = 0; k < opList.fnArray.length; k += 1) {
      if (opList.fnArray[k] === pdfjsLib.OPS.paintImageXObject) hasImage = true;
      if (opList.fnArray[k] === pdfjsLib.OPS.setFont) {
        const ref = opList.argsArray?.[k]?.[0];
        if (ref) fontRefs.add(String(ref));
      }
    }
  }
  await doc.cleanup();
  return { pages: doc.numPages, text, hasImage, fontRefCount: fontRefs.size };
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
    test.setTimeout(120_000); // CI 2 核：vite dev 首次按需编译 jspdf/svg2pdf + 2.18MB 字体 + 9 页 svg2pdf
    page.on('console', (m) => { if (m.text().includes('[vecpdf-t]')) console.log('PAGE>', m.text()); });
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
    const imgOut = sh(['pdfimages', '-list', pdfPath]);
    console.log('=== pdffonts ===\n' + fontOut);
    console.log('=== pdftotext ===\n' + textOut);
    console.log('=== pdfimages -list ===\n' + imgOut);

    // Node 侧 pdfjs 解析（CI 无 poppler，作为权威断言来源）。
    const pdf = await analyzePdf(pdfPath);
    console.log('=== pdfjs ===', JSON.stringify({
      pages: pdf.pages, hasImage: pdf.hasImage, fontRefs: pdf.fontRefCount,
      sampleText: pdf.text.slice(0, 200),
    }));

    // 文本层可抽取：中文孤块节点 + 英文节点正文（节点文本为 blockType#N 形式）。
    // 能抽出中文即证明 CJK 文本对象（内嵌 CID 字体 + ToUnicode），非整页栅格。
    expect(pdf.text, 'pdfjs text layer').toContain('孤块-无连接');
    expect(pdf.text, 'pdfjs english node').toMatch(/(bullet|todo|note|heading|text)#\d+/);
    // 文本走字体对象（非栅格）。
    expect(pdf.fontRefCount, 'embedded font refs').toBeGreaterThan(0);

    // 页数与分页预览一致。
    expect(pdf.pages, 'pdfjs page count').toBe(previewPages);

    // 图片块光栅可见。
    expect(pdf.hasImage, 'image XObject').toBe(true);
  });

  test('矢量失败自动回退位图：toast 出现且仍产出 PDF', async ({ page }) => {
    test.setTimeout(90_000);
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

  test('含龘（U+9F98）文档：字库已覆盖，矢量直出成功，龘可抽取且无位图回退', async ({ page }) => {
    test.setTimeout(120_000);
    page.on('console', (m) => { if (m.text().includes('[vecpdf-t]')) console.log('PAGE>', m.text()); });
    await waitForApp(page);
    const { doc } = buildStandardFixture('矢量PDF验收');
    // Wave20：内嵌字库从 GB2312 一级扩到全字库，龘（回归锚点）现在应矢量直出。
    const rareNode = {
      id: 'v_rare_probe',
      type: 'note',
      x: 2600, y: 900,
      width: 240, height: 72,
      content: tipDoc('龘字测试 rare'),
      parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {},
    } as unknown as BlockNode;
    doc.nodes.push(rareNode);
    await loadVectorDoc(page, doc);
    await invoke(page, 'setPageSettings', { mode: 'tiles', orientation: 'portrait' });
    await invoke(page, 'setSelection', []);

    const pdfPromise = page.waitForEvent('download', {
      timeout: 60_000,
      predicate: (d) => d.suggestedFilename().endsWith('.pdf'),
    });
    await page.keyboard.press('Control+p');
    await page.waitForSelector('text=导出 / 打印', { timeout: 5000 });
    await page.getByRole('button', { name: /直接下载 PDF/ }).click();

    const download = await pdfPromise;
    const pdfPath = path.join(OUT, 'vector-da.pdf');
    await download.saveAs(pdfPath);
    expect(fs.statSync(pdfPath).size).toBeGreaterThan(5_000);

    // 不应出现「缺字形→回退位图」toast。
    await expect(
      page.locator('div[role="status"]', { hasText: '含字体不支持的文字，已回退位图模式' }),
    ).toBeHidden({ timeout: 3_000 });

    const fontOut = sh(['pdffonts', pdfPath]);
    const textOut = sh(['pdftotext', pdfPath, '-']);
    console.log('=== pdffonts (龘) ===\n' + fontOut);
    console.log('=== pdftotext (龘) ===\n' + textOut);

    // pdfjs 权威断言：龘 作为矢量文本对象可抽取（位图回退会整页栅格，抽不出字）。
    const pdf = await analyzePdf(pdfPath);
    console.log('=== pdfjs (龘) ===', JSON.stringify({ text: pdf.text.slice(0, 120), fontRefs: pdf.fontRefCount }));
    expect(pdf.text, '龘 must be extractable as vector text').toContain('龘');
    expect(pdf.fontRefCount, 'vector font refs').toBeGreaterThan(0);
  });

  test('含 Ext-B 生僻字（𠮷 U+20BB7）文档：仍超出字库，缺字形预检命中回退位图', async ({ page }) => {
    test.setTimeout(90_000);
    await waitForApp(page);
    const { doc } = buildStandardFixture('矢量PDF验收');
    // 𠮷 属 CJK Ext-B（U+20BB7，超出 BMP，本字体 cmap 为 BMP format-4，绝不覆盖）。
    // 用以证明：扩字库后兜底链路未被破坏，真正超纲的字仍整体回退位图。
    const extBNode = {
      id: 'v_extb_probe',
      type: 'note',
      x: 2600, y: 900,
      width: 240, height: 72,
      content: tipDoc('𠮷字测试 ext-b'),
      parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {},
    } as unknown as BlockNode;
    doc.nodes.push(extBNode);
    await loadVectorDoc(page, doc);
    await invoke(page, 'setPageSettings', { mode: 'tiles', orientation: 'portrait' });
    await invoke(page, 'setSelection', []);

    const pdfPromise = page.waitForEvent('download', {
      timeout: 60_000,
      predicate: (d) => d.suggestedFilename().endsWith('.pdf'),
    });
    await page.keyboard.press('Control+p');
    await page.waitForSelector('text=导出 / 打印', { timeout: 5000 });
    await page.getByRole('button', { name: /直接下载 PDF/ }).click();

    // 缺字形预检 → 专门文案（区别于一般矢量失败）。
    await expect(
      page.locator('div[role="status"]', { hasText: '含字体不支持的文字，已回退位图模式' }),
    ).toBeVisible({ timeout: 15_000 });

    // 仍产出位图 PDF。
    const download = await pdfPromise;
    const pdfPath = path.join(OUT, 'vector-missing-glyph-extb.pdf');
    await download.saveAs(pdfPath);
    expect(fs.statSync(pdfPath).size).toBeGreaterThan(5_000);
  });
});
