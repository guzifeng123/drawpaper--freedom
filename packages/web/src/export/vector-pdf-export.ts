import type { KBNoteDoc, PageOrientation, PaginateResult } from '@drawpaper/core';
import { buildPagesSvgAsync } from './svg-export';
import { A4_PT } from './print-pipeline';
// 矢量 PDF 专用 CJK 字体（Noto Sans CJK SC 子集，OFL-1.1，CFF→glyf 经 cu2qu 转换）：
// jsPDF 标准 14 字体（Helvetica/Times/Courier）用 WinAnsi 编码，无法内嵌中文；
// 该 TTF 子集随 Vite 打到 dist/assets 并被 Service Worker 预缓存，离线可用。
// `?url` 让 Vite 产出带 hash 的静态资源，运行时 fetch 成 base64 交给 jsPDF。
import vectorFontUrl from './assets/vector-cjk.ttf?url';
// 字体覆盖的字符区间（构建期由字体 cmap 导出），用于缺字形预检。
import vectorCjkCmap from './assets/vector-cjk-cmap.json';

/** 注册进 jsPDF 后使用的字体族名（与 SVG <text font-family> 对应）。 */
const FONT_FAMILY = 'VecCJK';
const FONT_VFS_NAME = 'vec-cjk.ttf';

/** 缺字形预检抛出的错误标记；调用方据此切换专门的回退提示文案。 */
export const MISSING_GLYPH_MARKER = '__MISSING_GLYPH__';

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

let coverageSet: Set<number> | null = null;

/** 由构建期导出的 cmap 区间表展开成 codepoint 集合（仅算一次）。 */
function getCoverageSet(): Set<number> {
  if (coverageSet) return coverageSet;
  const set = new Set<number>();
  const ranges = (vectorCjkCmap as unknown as { ranges: number[][] }).ranges;
  for (const r of ranges) {
    const a = r[0]!;
    const b = r[1]!;
    for (let c = a; c <= b; c += 1) set.add(c);
  }
  coverageSet = set;
  return set;
}

/** 收集单页 SVG 里所有 <text> 的可见文本。 */
function collectSvgText(svgMarkup: string): string {
  const el = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml').documentElement;
  let out = '';
  el.querySelectorAll('text').forEach((t) => { out += t.textContent ?? ''; });
  return out;
}

/**
 * 缺字形预检：内嵌字体仅覆盖 GB2312 一级常用字（+ASCII/全角标点）。
 * 正文若含二级生僻字，矢量 PDF 会静默出现空白缺字。这里在渲染前扫描所有导出文本，
 * 发现字体不支持的字符（非 ASCII 且不在 cmap）就抛带标记错误，由调用方整体回退位图，
 * 避免交付缺字 PDF。
 */
function assertNoMissingGlyphs(svgPages: string[]): void {
  const coverage = getCoverageSet();
  const missing = new Set<string>();
  for (const markup of svgPages) {
    const text = collectSvgText(markup);
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp > 0x7e && !coverage.has(cp)) missing.add(ch);
    }
  }
  if (missing.size > 0) {
    throw new Error(`${MISSING_GLYPH_MARKER}: ${[...missing].join(' ')}`);
  }
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
 *  - 图片块以剥离后 jsPDF addImage 光栅嵌入；
 *  - 中文经嵌入的 glyf CJK 字体成为可抽取文本（ToUnicode CMap）。
 *
 * 失败（含 hang 超时）由调用方捕获并回退位图链路（不在此处静默）。
 */
export async function renderVectorPdf(
  result: PaginateResult,
  doc: KBNoteDoc,
  opts: VectorPdfOptions,
): Promise<VectorPdfResult> {
  // 真挂起守卫：svg2pdf / addImage 历史上会在异常 SVG 上永不 resolve。
  // 超过该时长即放弃矢量、抛错，由 useExportModel 回退位图（不等用户/playwright 超时）。
  // 正常矢量渲染远快于此（数秒~30s）；60s 仅捕获真正 hang，不误伤慢 runner。
  const HANG_TIMEOUT_MS = 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hangGuard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('vector pdf hang timeout (>60s), falling back')),
      HANG_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([renderVectorPdfInner(result, doc, opts), hangGuard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function renderVectorPdfInner(
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

  // 缺字形预检：含字体不支持的生僻字 → 整体回退位图（见 assertNoMissingGlyphs）。
  assertNoMissingGlyphs(svgPages);

  // 懒加载：jspdf + svg2pdf + CJK 字体仅在用户点「直接下载 PDF（矢量）」时拉取，不进首包。
  const _t0 = performance.now();
  const [{ jsPDF }, { svg2pdf }, fontBase64] = await Promise.all([
    import('jspdf'),
    import('svg2pdf.js'),
    loadVectorFontBase64(),
  ]);
  const _tImports = performance.now();

  const { width, height } = A4_PT[opts.orientation];
  const pdf = new jsPDF({ orientation: opts.orientation, unit: 'pt', format: 'a4' });
  pdf.addFileToVFS(FONT_VFS_NAME, fontBase64);
  pdf.addFont(FONT_VFS_NAME, FONT_FAMILY, 'normal');
  const _tFont = performance.now();

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

    const _tp = performance.now();
    await svg2pdf(svgEl, pdf, { x: 0, y: 0, width, height });
    const _tSvg = performance.now();

    for (const img of images) {
      const canvas = await dataUriToCanvas(img.href);
      pdf.addImage(canvas, 'PNG', img.x * scaleX, img.y * scaleY, img.w * scaleX, img.h * scaleY);
    }
    const _tImg = performance.now();
    console.log(`[vecpdf-t] page ${i + 1}/${svgPages.length} svg2pdf=${(_tSvg - _tp).toFixed(0)}ms img=${(_tImg - _tSvg).toFixed(0)}ms`);
  }

  const bytes = pdf.output('arraybuffer');
  const blob = new Blob([bytes], { type: 'application/pdf' });
  console.log(`[vecpdf-t] imports=${(_tImports - _t0).toFixed(0)}ms font=${(_tFont - _tImports).toFixed(0)}ms total=${(performance.now() - _t0).toFixed(0)}ms pages=${svgPages.length} fontB64=${(fontBase64.length / 1024).toFixed(0)}KB`);
  return { blob, fileName: opts.baseFileName };
}
