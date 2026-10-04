import type { KBNoteDoc, BlockNode, Edge } from '@drawpaper/core';
import type { PageSheet, PaginateResult } from '@drawpaper/core';
import { extractNodePlainText } from '@drawpaper/core';
import { pagePixelSize } from '@drawpaper/core';

/**
 * SVG 矢量导出：把每页序列化为独立 .svg（不引第三方依赖）。
 *  - 节点：<rect> + 纯文本（取块内纯文本前几行）；
 *  - 边：三次贝塞尔 + 箭头 marker；
 *  - 续接标记：<circle> + token 编号；
 *  - 页眉/页脚文本。
 * 多页 = 多个 .svg 文件分别下载（不打 zip）。
 */

export interface SvgExportOptions {
  orientation: 'portrait' | 'landscape';
  gray?: boolean;
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

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function renderNode(node: BlockNode, offset: { x: number; y: number }, gray?: boolean): string {
  const { fill, stroke } = nodeColor(node, gray);
  const w = node.width;
  const h = node.height;
  const lines = textLines(node);
  const tspans = lines
    .map((l, i) => `<tspan x="${offset.x + 8}" y="${offset.y + 20 + i * 16}">${escXml(l)}</tspan>`)
    .join('');
  return `<g class="node" data-node-id="${escXml(node.id)}">` +
    `<rect x="${offset.x}" y="${offset.y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1"/>` +
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
  const color = gray ? '#94A3B8' : edge.style.color || '#94A3B8';
  return `<g class="edge" data-edge-id="${escXml(edge.id)}">` +
    `<path d="${edgePath(a, b)}" fill="none" stroke="${color}" stroke-width="1.5" marker-end="url(#arrow)"/>` +
    `</g>`;
}

function renderSheet(sheet: PageSheet, doc: KBNoteDoc, size: { width: number; height: number }, opts: SvgExportOptions): string {
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
  const edges = new Map(doc.edges.map((e) => [e.id, e]));
  const offsets = sheet.nodeDrawOffsets ?? {};

  const nodeSvg = sheet.nodeIds
    .map((id) => nodes.get(id))
    .filter((n): n is BlockNode => Boolean(n))
    .map((n) => renderNode(n, offsets[n.id]!, opts.gray))
    .join('\n  ');

  const edgeSvg = sheet.edgeIds
    .map((id) => edges.get(id))
    .filter((e): e is Edge => Boolean(e))
    .map((e) => renderEdge(e, nodes, offsets, opts.gray))
    .join('\n  ');

  const contSvg = sheet.continuations
    .map(
      (c) =>
        `<g class="cont"><circle cx="${c.x}" cy="${c.y}" r="7" fill="#e0f2fe" stroke="#0284c7"/><text x="${c.x}" y="${c.y + 3}" font-size="8" text-anchor="middle" fill="#075985">${escXml(c.token.replace('cont:', ''))}</text></g>`,
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
  return result.pages.map((sheet) => renderSheet(sheet, doc, size, opts));
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
