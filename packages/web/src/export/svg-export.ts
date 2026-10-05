import type { KBNoteDoc, BlockNode, Edge } from '@drawpaper/core';
import type { PageSheet, PaginateResult } from '@drawpaper/core';
import { extractNodePlainText } from '@drawpaper/core';
import { pagePixelSize } from '@drawpaper/core';
import { buildEdgePath, type EdgeEnd } from '../editor/edges/edge-geometry';
import { assetRefToDataUri, isAssetRefSrc } from '../storage/opfs';

/**
 * SVG 矢量导出：把每页序列化为独立 .svg（不引第三方依赖）。
 *  - 节点：<rect> + 纯文本（取块内纯文本前几行）；图片块内联 <image href="data:...">；
 *  - 边：三次贝塞尔 + 箭头 marker；
 *  - 续接标记：<circle> + token 编号；
 *  - 页眉/页脚文本。
 * 多页 = 多个 .svg 文件分别下载（不打 zip）。
 *
 * Wave7 P2.1：OPFS 图片以自包含 data: URI 内嵌进 SVG（导出前由 buildPagesSvgAsync
 * 把 assetRef 读成 data URI），离线 .svg 双击即可看到图。
 */

export interface SvgExportOptions {
  orientation: 'portrait' | 'landscape';
  gray?: boolean;
  /** nodeId → 自包含 data: URI（图片节点）。缺省时若 image.src 已是 data: 也能内联。 */
  imageHrefs?: Record<string, string>;
}

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把块内文本按行切成最多 `maxLines` 行（近似宽度，按字符数折行）。 */
function textLines(node: BlockNode, maxLines = 4, charsPerLine = 18): string[] {
  const text = extractNodePlainText(node.content.data);
  if (!text) return [];
  const lines: string[] = [];
  let rest = text;
  while (lines.length < maxLines && rest.length > 0) {
    lines.push(rest.slice(0, charsPerLine));
    rest = rest.slice(charsPerLine);
  }
  if (rest.length > 0) lines[lines.length - 1] = (lines[lines.length - 1] ?? '') + '…';
  return lines;
}

function nodeColor(node: BlockNode, gray?: boolean): { fill: string; stroke: string } {
  if (gray) return { fill: '#ffffff', stroke: '#999999' };
  if (node.type === 'note') return { fill: '#FEF9C3', stroke: '#EAB308' };
  if (node.type === 'group') return { fill: '#F1F5F9', stroke: '#94A3B8' };
  return { fill: '#ffffff', stroke: '#CBD5E1' };
}


function renderNode(node: BlockNode, offset: { x: number; y: number }, opts: SvgExportOptions): string {
  const { fill, stroke } = nodeColor(node, opts.gray);
  const w = node.width;
  const h = node.height;
  const lines = textLines(node);
  const tspans = lines
    .map((l, i) => `<tspan x="${offset.x + 8}" y="${offset.y + 20 + i * 16}">${escXml(l)}</tspan>`)
    .join('');

  // 图片块：内联 <image>。href 优先取预解析好的 data: URI（assetRef 已读出），
  // 否则若 src 本身就是 data:/blob: 直接用；assetRef 且未预解析则跳过（不写坏引用）。
  let imageSvg = '';
  const rawSrc = node.image?.src;
  if (rawSrc) {
    const href = opts.imageHrefs?.[node.id] ?? (isAssetRefSrc(rawSrc) ? '' : rawSrc);
    if (href) {
      imageSvg = `<image x="${offset.x + 2}" y="${offset.y + 2}" width="${Math.max(0, w - 4)}" height="${Math.max(0, h - 4)}" preserveAspectRatio="xMidYMid meet" href="${escXml(href)}"/>`;
    }
  }

  return `<g class="node" data-node-id="${escXml(node.id)}">` +
    `<rect x="${offset.x}" y="${offset.y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1"/>` +
    (imageSvg ? imageSvg : '') +
    (tspans ? `<text font-size="12" fill="#334155">${tspans}</text>` : '') +
    `</g>`;
}

function renderEdge(
  edge: Edge,
  nodes: Map<string, BlockNode>,
  offsets: Record<string, { x: number; y: number }>,
  gray?: boolean,
): string {
  const s = nodes.get(edge.source);
  const t = nodes.get(edge.target);
  if (!s || !t) return '';
  const so = offsets[edge.source];
  const to = offsets[edge.target];
  if (!so || !to) return '';
  const a = { x: so.x + s.width, y: so.y + s.height / 2 };
  const b = { x: to.x, y: to.y + t.height / 2 };
  // 世界坐标弯折点 → 页本地（按 source 节点的世界→页本地偏移换算）
  const delta = { x: so.x - s.x, y: so.y - s.y };
  const localPoints = (edge.points ?? []).map((p) => ({ x: p.x + delta.x, y: p.y + delta.y }));
  const color = gray ? '#94A3B8' : edge.style.color || '#94A3B8';
  const sEnd: EdgeEnd = { x: a.x, y: a.y, position: 'right' };
  const tEnd: EdgeEnd = { x: b.x, y: b.y, position: 'left' };
  const d = buildEdgePath(sEnd, tEnd, localPoints);
  return `<g class="edge" data-edge-id="${escXml(edge.id)}">` +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" marker-end="url(#arrow)"/>` +
    `</g>`;
}

function renderSheet(
  sheet: PageSheet,
  doc: KBNoteDoc,
  size: { width: number; height: number },
  opts: SvgExportOptions,
  tokenToNumber?: ReadonlyMap<string, number>,
): string {
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
  const edges = new Map(doc.edges.map((e) => [e.id, e]));
  const offsets = sheet.nodeDrawOffsets ?? {};

  const nodeSvg = sheet.nodeIds
    .map((id) => nodes.get(id))
    .filter((n): n is BlockNode => Boolean(n))
    .map((n) => renderNode(n, offsets[n.id]!, opts))
    .join('\n  ');

  const edgeSvg = sheet.edgeIds
    .map((id) => edges.get(id))
    .filter((e): e is Edge => Boolean(e))
    .map((e) => renderEdge(e, nodes, offsets, opts.gray))
    .join('\n  ');

  const contSvg = sheet.continuations
    .map(
      (c) =>
        `<g class="cont"><circle cx="${c.x}" cy="${c.y}" r="7" fill="#e0f2fe" stroke="#0284c7"/><text x="${c.x}" y="${c.y + 3}" font-size="8" text-anchor="middle" fill="#075985">${tokenToNumber?.get(c.token) ?? escXml(c.token.replace('cont:', ''))}</text></g>`,
    )
    .join('\n  ');

  const header = sheet.headerText
    ? `<text x="${size.width / 2}" y="${20}" font-size="11" text-anchor="middle" fill="#64748b">${escXml(sheet.headerText)}</text>`
    : '';
  const footer = sheet.footerText
    ? `<text x="${size.width / 2}" y="${size.height - 10}" font-size="10" text-anchor="middle" fill="#64748b">${escXml(sheet.footerText)} · ${sheet.pageNumber + 1}</text>`
    : `<text x="${size.width / 2}" y="${size.height - 10}" font-size="10" text-anchor="middle" fill="#94a3b8">${sheet.pageNumber + 1}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${opts.gray ? '#94A3B8' : '#64748b'}"/>
    </marker>
  </defs>
  <rect width="${size.width}" height="${size.height}" fill="#ffffff"/>
  ${header}
  ${edgeSvg}
  ${nodeSvg}
  ${contSvg}
  ${footer}
</svg>`;
}

/** 把分页结果逐页构建为 SVG 字符串数组。 */
export function buildPagesSvg(
  result: PaginateResult,
  doc: KBNoteDoc,
  opts: SvgExportOptions,
): string[] {
  const size = pagePixelSize(opts.orientation);
  // 与 PrintSheets 一致：按 token 首次出现顺序分配成对短编号。
  const tokenToNumber = new Map<string, number>();
  for (const sheet of result.pages) {
    for (const c of sheet.continuations) {
      if (!tokenToNumber.has(c.token)) tokenToNumber.set(c.token, tokenToNumber.size + 1);
    }
  }
  return result.pages.map((sheet) => renderSheet(sheet, doc, size, opts, tokenToNumber));
}

/** 逐页下载 .svg（不打 zip）。 */
export function downloadSvgPages(svgPages: string[], baseFileName: string): void {
  const dot = baseFileName.lastIndexOf('.');
  const stem = dot > 0 ? baseFileName.slice(0, dot) : baseFileName;
  svgPages.forEach((svg, i) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${stem}_p${i + 1}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}

/**
 * 遍历文档图片节点，把 assetRef 读成自包含 data: URI（供 SVG 内嵌）。
 * data: 内联图片原样收集；assetRef 读不到则跳过（不写坏引用）。
 */
export async function resolveImageHrefs(doc: KBNoteDoc): Promise<Record<string, string>> {
  const hrefs: Record<string, string> = {};
  await Promise.all(
    doc.nodes.map(async (n) => {
      const src = n.image?.src;
      if (!src) return;
      if (!isAssetRefSrc(src)) {
        hrefs[n.id] = src;
        return;
      }
      const dataUri = await assetRefToDataUri(src);
      if (dataUri) hrefs[n.id] = dataUri;
    }),
  );
  return hrefs;
}

/** 异步版：先把 OPFS 图片解析成 data: URI，再逐页构建 SVG。 */
export async function buildPagesSvgAsync(
  result: PaginateResult,
  doc: KBNoteDoc,
  opts: SvgExportOptions,
): Promise<string[]> {
  const imageHrefs = await resolveImageHrefs(doc);
  return buildPagesSvg(result, doc, { ...opts, imageHrefs });
}
