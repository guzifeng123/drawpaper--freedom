/**
 * 打印 / 位图导出管线。
 * - 矢量主线：动态注入 @page，body 加 class 隐藏应用外壳，window.print()。
 * - 位图：html-to-image(scale≈3) 逐页 PNG → pdf-lib 合成多页 PDF。
 */
import { toPng } from 'html-to-image';
import { PDFDocument } from 'pdf-lib';
import type { PageOrientation } from '@drawpaper/core';
import { buildPageFileName } from './filename';

/** A4 尺寸（pt，PDF 标准）。 */
export const A4_PT = {
  portrait: { width: 595.28, height: 841.89 },
  landscape: { width: 841.89, height: 595.28 },
} as const;

const PRINT_STYLE_ID = 'drawpaper-print-page-style';

/** 注入随方向切换的 @page 规则；返回清理函数。 */
export function installPageStyle(orientation: PageOrientation): () => void {
  const existing = document.getElementById(PRINT_STYLE_ID);
  const css = `@page { size: A4 ${orientation === 'landscape' ? 'landscape' : 'portrait'}; margin: 0; }`;
  if (existing) {
    existing.textContent = css;
  } else {
    const el = document.createElement('style');
    el.id = PRINT_STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }
  return () => {
    document.getElementById(PRINT_STYLE_ID)?.remove();
  };
}

/** 触发浏览器打印（矢量另存 PDF）。调用前应已挂载 <PrintSheets/>。 */
export async function runVectorPrint(orientation: PageOrientation): Promise<void> {
  const cleanupPage = installPageStyle(orientation);
  document.body.classList.add('drawpaper-printing');
  try {
    // 等字体与图片解码完成再打印，避免缺字/缺图。
    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise((res) => setTimeout(res, 50));
    window.print();
    // 浏览器打印是阻塞的（dialog），返回后清理。
  } finally {
    document.body.classList.remove('drawpaper-printing');
    cleanupPage();
  }
}

function triggerDownload(dataUrl: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 逐页导出高清 PNG（pixelRatio≈3）。 */
export async function downloadSheetsAsPng(
  sheets: HTMLElement[],
  baseFileName: string,
): Promise<void> {
  for (let i = 0; i < sheets.length; i++) {
    const el = sheets[i];
    if (!el) continue;
    const dataUrl = await toPng(el, { pixelRatio: 3, backgroundColor: '#ffffff' });
    triggerDownload(dataUrl, buildPageFileName(baseFileName, i));
  }
}

/** 直接下载 PDF：把每页位图（scale≈3）按 A4 pt 合成多页 PDF。 */
export async function downloadSheetsAsPdf(
  sheets: HTMLElement[],
  baseFileName: string,
  orientation: PageOrientation,
): Promise<void> {
  const pdf = await PDFDocument.create();
  const { width, height } = A4_PT[orientation];
  for (const el of sheets) {
    const dataUrl = await toPng(el, { pixelRatio: 3, backgroundColor: '#ffffff' });
    const pngBytes = await (await fetch(dataUrl)).arrayBuffer();
    const img = await pdf.embedPng(pngBytes);
    const page = pdf.addPage([width, height]);
    page.drawImage(img, { x: 0, y: 0, width, height });
  }
  const bytes = await pdf.save();
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, baseFileName);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 取当前离屏打印容器里的所有 .sheet 元素。 */
export function collectSheetElements(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.drawpaper-print-container .sheet'),
  );
}
