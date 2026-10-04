import { createPortal } from 'react-dom';
import type {
  BlockNode,
  Edge,
  KBNoteDoc,
  PageSettings,
  PaginateResult,
} from '@drawpaper/core';
import { mmToPx } from '@drawpaper/core';
import { TiptapStatic } from './render/tiptap-static';
import { sheetSizePx, pageNumberLabel } from './layout-utils';

/**
 * 离屏打印容器（body 下 portal）。
 * - 屏幕上 display:none；打印时 body 加 .drawpaper-printing 后可见（见 index.css）。
 * - 每页一个严格 A4 比例 .sheet；节点按 worldRect 偏移绝对定位；边用 SVG 绘制。
 * - 孤块黄色角标；跨页续接标记画同编号小圆圈；折叠子树不出现（core 已剔除）。
 */
export interface PrintSheetsProps {
  result: PaginateResult;
  doc: KBNoteDoc;
  settings: PageSettings;
  edgeLabelsVisible: boolean;
}

export function PrintSheets({ result, doc, settings, edgeLabelsVisible }: PrintSheetsProps) {
  const sheet = sheetSizePx(settings.orientation);
  const margin = mmToPx(settings.marginMm);
  const gray = settings.colorMode === 'gray';
  const nodeById = new Map<string, BlockNode>(doc.nodes.map((n) => [n.id, n]));
  const edgeById = new Map<string, Edge>(doc.edges.map((e) => [e.id, e]));
  const orphanIds = new Set(result.orphans.map((o) => o.nodeId));

  return createPortal(
    <div className={gray ? 'drawpaper-print-container tp-gray' : 'drawpaper-print-container'}>
      {result.pages.map((page) => {
        const scale = page.scale || 1;
        // 节点在本页的「绘制矩形」（page-local px，已含 core 的 clamp/居中/缩放）。
        // core 的 nodeDrawOffsets 是唯一真相；缺省时回退到 worldRect 折算。
        const drawnRect = (n: BlockNode): { x: number; y: number; w: number; h: number } => {
          const off = page.nodeDrawOffsets?.[n.id];
          if (off) return { x: off.x, y: off.y, w: n.width * scale, h: n.height * scale };
          return {
            x: margin + (n.x - page.worldRect.x) * scale,
            y: margin + (n.y - page.worldRect.y) * scale,
            w: n.width * scale,
            h: n.height * scale,
          };
        };
        return (
          <div
            key={page.index}
            data-page={page.index}
            className="sheet relative bg-white"
            style={{
              width: sheet.width,
              height: sheet.height,
              pageBreakAfter: 'always',
            }}
          >
            {/* 页眉 */}
            {settings.header ? (
              <div
                className="absolute text-xs text-muted-foreground"
                style={{ left: margin, top: margin / 2, right: margin }}
              >
                {doc.title}
              </div>
            ) : null}

            {/* 内容区（世界 → 内容区左上角） */}
            {settings.mode === 'flow' ? (
              <div className="flow-content absolute" style={{ left: margin, top: margin, right: margin, bottom: margin }}>
                {page.nodeIds.map((id) => {
                  const n = nodeById.get(id);
                  if (!n) return null;
                  return (
                    <div key={id} className="mb-3 rounded border p-2">
                      <TiptapStatic doc={n.content.data} gray={gray} />
                    </div>
                  );
                })}
              </div>
            ) : (
              <>
                {/* 节点 */}
                {page.nodeIds.map((id) => {
                  const n = nodeById.get(id);
                  if (!n) return null;
                  const rect = drawnRect(n);
                  return (
                    <div
                      key={id}
                      data-node-id={id}
                      className="absolute rounded border bg-white p-2"
                      style={{
                        left: rect.x,
                        top: rect.y,
                        width: rect.w,
                        minHeight: rect.h,
                      }}
                    >
                      <TiptapStatic doc={n.content.data} gray={gray} />
                      {orphanIds.has(id) ? (
                        <span
                          data-orphan-badge
                          className="absolute -right-1 -top-1 rounded bg-amber-400 px-1 text-[9px] text-amber-900"
                        >
                          孤
                        </span>
                      ) : null}
                    </div>
                  );
                })}

                {/* 边（每页内 SVG） */}
                <svg
                  className="pointer-events-none absolute"
                  style={{ left: 0, top: 0, width: sheet.width, height: sheet.height }}
                >
                  <defs>
                    <marker
                      id={`arrow-${page.index}`}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" fill={gray ? '#333' : '#94A3B8'} />
                    </marker>
                  </defs>
                  {page.edgeIds.map((eid) => {
                    const e = edgeById.get(eid);
                    const s = e && nodeById.get(e.source);
                    const t = e && nodeById.get(e.target);
                    if (!e || !s || !t) return null;
                    const sr = drawnRect(s);
                    const tr = drawnRect(t);
                    const x1 = sr.x + sr.w;
                    const y1 = sr.y + sr.h / 2;
                    const x2 = tr.x;
                    const y2 = tr.y + tr.h / 2;
                    const cx1 = x1 + Math.max(40, (x2 - x1) / 2);
                    const cx2 = x2 - Math.max(40, (x2 - x1) / 2);
                    const color = gray ? '#333' : e.style.color;
                    return (
                      <g key={eid}>
                        <path
                          d={`M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`}
                          fill="none"
                          stroke={color}
                          strokeWidth={1.5}
                          markerEnd={`url(#arrow-${page.index})`}
                        />
                        {edgeLabelsVisible && e.label ? (
                          <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} fontSize={9} fill={gray ? '#333' : '#64748b'} textAnchor="middle">
                            {e.label}
                          </text>
                        ) : null}
                      </g>
                    );
                  })}

                  {/* 跨页续接标记：同编号小圆圈 */}
                  {page.continuations.map((c) => (
                    <g key={c.token + c.pageIndex}>
                      <circle
                        cx={c.x}
                        cy={c.y}
                        r={9}
                        fill="#fff"
                        stroke={gray ? '#333' : '#0ea5e9'}
                        strokeWidth={1.5}
                      />
                      <text
                        x={c.x}
                        y={c.y + 3}
                        fontSize={8}
                        textAnchor="middle"
                        fill={gray ? '#333' : '#0ea5e9'}
                      >
                        {c.token}
                      </text>
                    </g>
                  ))}
                </svg>
              </>
            )}

            {/* 页脚 */}
            {settings.footer ? (
              <div
                className="absolute flex items-center justify-between text-xs text-muted-foreground"
                style={{ left: margin, right: margin, bottom: margin / 2 }}
              >
                <span>{settings.header ? '' : doc.title}</span>
                {settings.showPageNumbers ? <span>{pageNumberLabel(page.index, result.totalPages)}</span> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
