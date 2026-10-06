/**
 * 打印 / 位图导出管线。
 * - 矢量主线：动态注入 @page，body 加 class 隐藏应用外壳，window.print()。
 * - 位图：html-to-image(scale≈3) 逐页 PNG → pdf-lib 合成多页 PDF。
 */
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

/** 取当前离屏打印容器里的所有 .sheet 元素。 */
export function collectSheetElements(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.drawpaper-print-container .sheet'),
  );
}

/**
 * 位图捕获前：把屏幕上 display:none 的打印容器临时「移到屏幕外但可见」。
 * html-to-image 无法渲染 display:none 的元素，必须让它参与布局。
 * 返回清理函数：恢复原状。
 */
function revealOffScreenForCapture(): () => void {
  const container = document.querySelector<HTMLElement>('.drawpaper-print-container');
  if (!container) return () => undefined;
  const prev = {
    display: container.style.display,
    position: container.style.position,
    left: container.style.left,
    top: container.style.top,
    zIndex: container.style.zIndex,
  };
  container.style.display = 'block';
  container.style.position = 'fixed';
  container.style.left = '-100000px';
  container.style.top = '0';
  container.style.zIndex = '-1';
  return () => {
    container.style.display = prev.display;
    container.style.position = prev.position;
    container.style.left = prev.left;
    container.style.top = prev.top;
    container.style.zIndex = prev.zIndex;
  };
}

/** 逐页导出高清 PNG（pixelRatio≈3）为 Blob（不在此处触发下载）。 */
export async function renderSheetsAsPng(
  sheets: HTMLElement[],
  baseFileName: string,
): Promise<{ blob: Blob; fileName: string }[]> {
  const restore = revealOffScreenForCapture();
  try {
    // 懒加载：html-to-image 仅在用户点「导出 PNG」时拉取，不进首包。
    const { toPng } = await import('html-to-image');
    const out: { blob: Blob; fileName: string }[] = [];
    for (let i = 0; i < sheets.length; i++) {
      const el = sheets[i];
      if (!el) continue;
      const dataUrl = await toPng(el, { pixelRatio: 3, backgroundColor: '#ffffff' });
      const blob = await (await fetch(dataUrl)).blob();
      out.push({ blob, fileName: buildPageFileName(baseFileName, i) });
    }
    return out;
  } finally {
    restore();
  }
}

/** 直接合成 PDF（位图）为 Blob（不在此处触发下载）。 */
export async function renderSheetsAsPdf(
  sheets: HTMLElement[],
  baseFileName: string,
  orientation: PageOrientation,
): Promise<{ blob: Blob; fileName: string }> {
  const restore = revealOffScreenForCapture();
  try {
    // 懒加载：pdf-lib + html-to-image 仅在用户点「直接下载 PDF」时拉取，不进首包。
    const [{ PDFDocument }, { toPng }] = await Promise.all([
      import('pdf-lib'),
      import('html-to-image'),
    ]);
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
    return { blob, fileName: baseFileName };
  } finally {
    restore();
  }
}
