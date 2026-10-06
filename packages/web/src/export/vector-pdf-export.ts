import type { KBNoteDoc, PageOrientation, PaginateResult } from '@drawpaper/core';
import { buildPagesSvgAsync } from './svg-export';
import { A4_PT } from './print-pipeline';
// 矢量 PDF 专用 CJK 字体（AR PL UMing CN 子集，glyf 轮廓）：
// jsPDF 标准 14 字体（Helvetica/Times/Courier）用 WinAnsi 编码，无法内嵌中文；
// 该 TTF 子集随 Vite 打到 dist/assets 并被 Service Worker 预缓存，离线可用。
// `?url` 让 Vite 产出带 hash 的静态资源，运行时 fetch 成 base64 交给 jsPDF。
import vectorFontUrl from './assets/vector-cjk.ttf?url';

/** 注册进 jsPDF 后使用的字体族名（与 SVG <text font-family> 对应）。 */
const FONT_FAMILY = 'VecCJK';
const FONT_VFS_NAME = 'vec-cjk.ttf';

export interface VectorPdfOptions {
  orientation: PageOrientation;
  /** 黑白模式（与位图导出一致）。 */
  gray: boolean;
  /** 交付文件名（含扩展名）。 */
  baseFileName: string;
}

export interface VectorPdfResult {
  blob: Blob;
  fileName: string;
}

/** fetch 字体 URL → base64（jsPDF addFileToVFS 需要 base64 字符串）。 */
async function loadVectorFontBase64(): Promise<string> {
  const res = await fetch(vectorFontUrl);
  if (!res.ok) throw new Error(`vector font fetch failed: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * 给 SVG 里所有 <text> 注入 font-family="VecCJK"。
 * svg2pdf 的字体解析会在 pdf.getFontList() 里按族名命中已嵌入字体；
 * 不注入则回退到 Helvetica（WinAnsi），中文变乱码。<tspan> 继承父级，无需单独处理。
 */
function injectFontFamily(svg: string): string {
  return svg.replace(/<text(?=[\s>])/g, `<text font-family="${FONT_FAMILY}"`);
}

interface ExtractedImage {
  href: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 从解析后的 SVG 里剥离所有 <image>，记录其矩形与 data: URI。
 * svg2pdf 对 <image> 光栅在本环境会挂起（实测），故改由 jsPDF addImage 单独嵌入，
 * 坐标按 SVG 像素→PDF pt 的缩放比换算。
 */
function extractAndStripImages(svgEl: SVGSVGElement): ExtractedImage[] {
  const out: ExtractedImage[] = [];
  const imgs = svgEl.querySelectorAll('image');
  imgs.forEach((el) => {
    const x = parseFloat(el.getAttribute('x') ?? '0');
    const y = parseFloat(el.getAttribute('y') ?? '0');
    const w = parseFloat(el.getAttribute('width') ?? '0');
    const h = parseFloat(el.getAttribute('height') ?? '0');
    const href = el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '';
    if (!href || w <= 0 || h <= 0) return;
    out.push({ href, x, y, w, h });
    el.remove();
  });
  return out;
}

/**
 * data: URI 解码为 canvas。jsPDF addImage 直接吃 data: URI 字符串会在本环境卡死，
 * 故先在浏览器侧用 <img> + canvas 解码，再把 canvas 交给 addImage（同步路径）。
 */
async function dataUriToCanvas(dataUri: string): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = dataUri;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || 1;
  canvas.height = img.naturalHeight || 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('vector pdf: canvas 2d unavailable');
  ctx.drawImage(img, 0, 0);
  return canvas;
}

/**
 * 矢量直下载 PDF：与 .svg 导出同源（buildPagesSvgAsync）逐页产出 SVG，
 * 再用 svg2pdf.js（jsPDF 渲染后端）逐页画成真正的矢量 PDF：
 *  - 节点/边/续接标记/页眉页脚为矢量路径与文本对象（可选、可搜索、可复制）；
 *  - 图片块以 <image data:...> 由 svg2pdf 光栅嵌入（embedImage）；
 *  - 中文经嵌入的 glyf CJK 字体成为可抽取文本（ToUnicode CMap）。
 *
 * 失败由调用方捕获并回退位图链路（不在此处静默）。
 */
export async function renderVectorPdf(
  result: PaginateResult,
  doc: KBNoteDoc,
  opts: VectorPdfOptions,
): Promise<VectorPdfResult> {
  // 测试缝：e2e 强制矢量失败，验证自动回退位图。
  if ((globalThis as unknown as { __drawpaper__?: { __forceVectorPdfFail__?: boolean } })
    .__drawpaper__?.__forceVectorPdfFail__) {
    throw new Error('forced vector failure (test seam)');
  }

  const svgPages = await buildPagesSvgAsync(result, doc, {
    orientation: opts.orientation,
    gray: opts.gray,
  });
  if (svgPages.length === 0) throw new Error('vector pdf: no pages');

  // 懒加载：jspdf + svg2pdf + CJK 字体仅在用户点「直接下载 PDF（矢量）」时拉取，不进首包。
  const [{ jsPDF }, { svg2pdf }, fontBase64] = await Promise.all([
    import('jspdf'),
    import('svg2pdf.js'),
    loadVectorFontBase64(),
  ]);

  const { width, height } = A4_PT[opts.orientation];
  const pdf = new jsPDF({ orientation: opts.orientation, unit: 'pt', format: 'a4' });
  pdf.addFileToVFS(FONT_VFS_NAME, fontBase64);
  pdf.addFont(FONT_VFS_NAME, FONT_FAMILY, 'normal');

  for (let i = 0; i < svgPages.length; i += 1) {
    if (i > 0) pdf.addPage('a4', opts.orientation);
    const svgMarkup = injectFontFamily(svgPages[i]!);
    const svgEl = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml').documentElement;
    if (!(svgEl instanceof SVGSVGElement)) throw new Error('vector pdf: svg parse failed');

    const images = extractAndStripImages(svgEl);

    // SVG 像素坐标系 → PDF pt 的缩放比（svg2pdf 把 viewBox 缩放到 {width,height}）。
    const svgW = parseFloat(svgEl.getAttribute('width') ?? '0') || width;
    const svgH = parseFloat(svgEl.getAttribute('height') ?? '0') || height;
    const scaleX = width / svgW;
    const scaleY = height / svgH;

    await svg2pdf(svgEl, pdf, { x: 0, y: 0, width, height });

    for (const img of images) {
      const canvas = await dataUriToCanvas(img.href);
      pdf.addImage(canvas, 'PNG', img.x * scaleX, img.y * scaleY, img.w * scaleX, img.h * scaleY);
    }
  }

  const bytes = pdf.output('arraybuffer');
  const blob = new Blob([bytes], { type: 'application/pdf' });
  return { blob, fileName: opts.baseFileName };
}
