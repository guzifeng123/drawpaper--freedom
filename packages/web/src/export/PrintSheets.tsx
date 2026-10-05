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
import { buildEdgePath } from '../editor/edges/edge-geometry';

/** 续接标记圆圈半径（px）。 */
const MARKER_R = 9;
/** 边标签与标记圆圈中心的安全距离（圆圈半径 + 标签半高 + 间隙）。 */
const LABEL_SAFE_R = 20;

/**
 * 计算边自由标签的落点：贝塞尔中点为基准，沿「推离标记圆圈」方向平移，
 * 避免长标签压住续接标记圆圈/数字；迭代 2~3 次稳定。
 */
function placeEdgeLabel(
  mx: number,
  my: number,
  markers: ReadonlyArray<{ x: number; y: number }>,
): { x: number; y: number } {
  let lx = mx;
  let ly = my - 6;
  for (let iter = 0; iter < 3; iter++) {
    for (const m of markers) {
      const dx = lx - m.x;
      const dy = ly - m.y;
      const d = Math.hypot(dx, dy);
      if (d < LABEL_SAFE_R && d > 1e-6) {
        const push = LABEL_SAFE_R - d;
        lx += (dx / d) * push;
        ly += (dy / d) * push;
      }
    }
  }
  return { x: lx, y: ly };
}

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

  // 成对续接标记编号：按 token 首次出现顺序分配 1..N（两页共享同一编号）。
  // 圆圈内只显示短数字，不再塞整条 edgeId，避免溢出压住旁边的边标签。
  const tokenToNumber = new Map<string, number>();
  for (const p of result.pages) {
    for (const c of p.continuations) {
      if (!tokenToNumber.has(c.token)) tokenToNumber.set(c.token, tokenToNumber.size + 1);
    }
  }

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
                  {(() => {
                    const markers = page.continuations.map((c) => ({ x: c.x, y: c.y }));
                    return page.edgeIds.map((eid) => {
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
                      // 世界坐标弯折点 → 页本地（按 source 节点换算）
                      const delta = { x: sr.x - s.x, y: sr.y - s.y };
                      const localPoints = (e.points ?? []).map((p) => ({ x: p.x + delta.x, y: p.y + delta.y }));
                      const color = gray ? '#333' : e.style.color;
                      const anchor = edgeLabelsVisible && e.label
                        ? placeEdgeLabel((x1 + x2) / 2, (y1 + y2) / 2, markers)
                        : null;
                      return (
                        <g key={eid}>
                          <path
                            d={buildEdgePath(
                              { x: x1, y: y1, position: 'right' },
                              { x: x2, y: y2, position: 'left' },
                              localPoints,
                            )}
                            fill="none"
                            stroke={color}
                            strokeWidth={1.5}
                            markerEnd={`url(#arrow-${page.index})`}
                          />
                          {anchor ? (
                            <text
                              x={anchor.x}
                              y={anchor.y}
                              fontSize={9}
                              fill={gray ? '#111827' : '#334155'}
                              textAnchor="middle"
                              stroke="#ffffff"
                              strokeWidth={3}
                              paintOrder="stroke"
                            >
                              {e.label}
                            </text>
                          ) : null}
                        </g>
                      );
                    });
                  })()}

                  {/* 跨页续接标记：同编号小圆圈 */}
                  {page.continuations.map((c) => (
                    <g key={c.token + c.pageIndex}>
                      <circle
                        cx={c.x}
                        cy={c.y}
                        r={MARKER_R}
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
                        {tokenToNumber.get(c.token) ?? ''}
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
