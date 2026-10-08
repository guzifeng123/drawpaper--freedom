import * as React from 'react';
import type { PaginateResult, Viewport } from '@drawpaper/core';

export interface ManualBreak {
  id: string;
  x: number;
  y: number;
}

/**
 * 画布上的 A4 分页虚线叠加层（纯展示组件）。
 *
 * - 按每页 worldRect 画虚线 A4 矩形 + 页码。
 * - 分页原点手柄可整体拖动 → onDragOrigin。
 * - 手动分页符（breaks）渲染为可拖动竖线手柄；点选高亮，Delete/Backspace 删除，Esc 取消选中。
 */
export interface PageBreakOverlayProps {
  result: PaginateResult;
  viewport: Viewport;
  onDragOrigin?: (origin: { x: number; y: number }) => void;
  /** 手动分页符列表（世界坐标）。 */
  breaks?: ManualBreak[];
  /** 松手后防抖写回新位置。 */
  onMoveBreak?: (id: string, x: number, y: number) => void;
  /** 删除分页符。 */
  onDeleteBreak?: (id: string) => void;
}

export const PageBreakOverlay = React.memo(function PageBreakOverlay({
  result,
  viewport,
  onDragOrigin,
  breaks = [],
  onMoveBreak,
  onDeleteBreak,
}: PageBreakOverlayProps) {
  const { zoom, x: vx, y: vy } = viewport;
  const orphanNodeIds = new Set(result.orphans.map((o) => o.nodeId));
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const dragState = React.useRef<{
    id: string; startX: number; startY: number; origX: number; origY: number;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!onDragOrigin) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const first = result.pages[0];
    dragState.current = {
      id: '__origin__',
      startX: e.clientX,
      startY: e.clientY,
      origX: first?.worldRect.x ?? 0,
      origY: first?.worldRect.y ?? 0,
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const ds = dragState.current;
    if (!ds || ds.id !== '__origin__' || !onDragOrigin) return;
    const dx = (e.clientX - ds.startX) / zoom;
    const dy = (e.clientY - ds.startY) / zoom;
    onDragOrigin({ x: ds.origX + dx, y: ds.origY + dy });
  };
  const onPointerUp = () => {
    dragState.current = null;
  };

  // 分页符手柄拖动（独立 pointer capture，写回 onMoveBreak）。
  const breakDrag = React.useRef<{
    id: string; startX: number; startY: number; origX: number; origY: number; moved: boolean;
  } | null>(null);
  const onBreakDown = (e: React.PointerEvent, b: ManualBreak) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSelectedId(b.id);
    breakDrag.current = { id: b.id, startX: e.clientX, startY: e.clientY, origX: b.x, origY: b.y, moved: false };
  };
  const onBreakMove = (e: React.PointerEvent) => {
    const bd = breakDrag.current;
    if (!bd || !onMoveBreak) return;
    const dx = (e.clientX - bd.startX) / zoom;
    const dy = (e.clientY - bd.startY) / zoom;
    if (Math.abs(dx) + Math.abs(dy) > 2) bd.moved = true;
  };
  const onBreakUp = (e: React.PointerEvent) => {
    const bd = breakDrag.current;
    if (bd?.moved && onMoveBreak) {
      const dx = (e.clientX - bd.startX) / zoom;
      const dy = (e.clientY - bd.startY) / zoom;
      onMoveBreak(bd.id, bd.origX + dx, bd.origY + dy);
    }
    breakDrag.current = null;
  };

  // Delete/Backspace 删除选中分页符；Esc 取消选中。
  React.useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedId(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && onDeleteBreak) {
        onDeleteBreak(selectedId);
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, onDeleteBreak]);

  return (
    <div
      data-testid="page-break-overlay"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ zIndex: 5 }}
    >
      {result.pages.map((page) => {
        const left = page.worldRect.x * zoom + vx;
        const top = page.worldRect.y * zoom + vy;
        const width = page.worldRect.width * zoom;
        const height = page.worldRect.height * zoom;
        const hasOrphan = page.nodeIds.some((id) => orphanNodeIds.has(id));
        return (
          <div
            key={page.index}
            className="absolute border-2 border-dashed border-sky-500/70"
            style={{ left, top, width, height }}
          >
            <span className="absolute -top-5 left-0 rounded bg-sky-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
              {page.index + 1}
            </span>
            {hasOrphan ? (
              <span className="absolute right-0 top-0 rounded-bl bg-amber-400 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">
                孤块
              </span>
            ) : null}
          </div>
        );
      })}

      {/* 手动分页符：可拖动竖线手柄 */}
      {breaks.map((b) => {
        const left = b.x * zoom + vx;
        const top = b.y * zoom + vy;
        const sel = selectedId === b.id;
        return (
          <div
            key={b.id}
            data-testid="manual-break"
            data-break-id={b.id}
            className="pointer-events-auto absolute"
            style={{
              left,
              top,
              width: 12,
              height: (result.pages[0]?.worldRect.height ?? 800) * zoom,
              marginLeft: -6,
              touchAction: 'none',
              cursor: 'grab',
            }}
            onPointerDown={(e) => onBreakDown(e, b)}
            onPointerMove={onBreakMove}
            onPointerUp={(e) => onBreakUp(e)}
          >
            <div
              className={`absolute w-0.5 ${sel ? 'bg-rose-500' : 'bg-rose-400/80'}`}
              style={{ height: '100%', left: 6 }}
            />
            <div
              className={`absolute h-3 w-3 rounded-full border-2 ${sel ? 'border-rose-600 bg-rose-500' : 'border-white bg-rose-400'}`}
              style={{ left: 2, top: -6 }}
            />
          </div>
        );
      })}

      {/* 分页原点拖动手柄 */}
      {result.pages.length > 0 && onDragOrigin ? (() => {
        // 手柄代表分页原点角点；但默认视口（fitView 后）角点常落在屏幕 (0,0)，
        // 被顶部工具栏（z-20）压住抓不到。把手柄夹紧到视口安全区，并抬高层级。
        const rawLeft = (result.pages[0]?.worldRect.x ?? 0) * zoom + vx;
        const rawTop = (result.pages[0]?.worldRect.y ?? 0) * zoom + vy;
        const left = Math.max(rawLeft, 56);
        const top = Math.max(rawTop, 56);
        return (
          <div
            data-testid="page-origin-handle"
            className="pointer-events-auto absolute h-4 w-4 cursor-move rounded-full border-2 border-white bg-sky-500 shadow"
            style={{
              left,
              top,
              touchAction: 'none',
              zIndex: 30,
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            title="拖动调整分页原点"
          />
        );
      })() : null}
    </div>
  );
});
