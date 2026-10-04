import * as React from 'react';
import type { PaginateResult } from '@drawpaper/core';
import type { Viewport } from '@drawpaper/core';

/**
 * 画布上的 A4 分页虚线叠加层（纯展示组件）。
 *
 * 设计：接受「已算好的 PaginateResult」与当前视口变换作为 props，
 * 不直接读 store / React Flow 内部状态，便于单测与复用。
 * - 按每页 worldRect 画虚线 A4 矩形 + 页码。
 * - 分页原点手柄可整体拖动 → onDragOrigin。
 * - 含孤块的页面标黄角标。
 * - 仅在外层传入 showPageBreak 时由父级挂载。
 */
export interface PageBreakOverlayProps {
  result: PaginateResult;
  viewport: Viewport;
  /** 分页原点整体拖动回调（世界坐标）。 */
  onDragOrigin?: (origin: { x: number; y: number }) => void;
}

export const PageBreakOverlay = React.memo(function PageBreakOverlay({
  result,
  viewport,
  onDragOrigin,
}: PageBreakOverlayProps) {
  const { zoom, x: vx, y: vy } = viewport;
  const orphanNodeIds = new Set(result.orphans.map((o) => o.nodeId));

  const dragState = React.useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!onDragOrigin) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // 当前原点 = 第一页 worldRect 左上（拖动基准）
    const first = result.pages[0];
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: first?.worldRect.x ?? 0,
      originY: first?.worldRect.y ?? 0,
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const ds = dragState.current;
    if (!ds || !onDragOrigin) return;
    const dx = (e.clientX - ds.startX) / zoom;
    const dy = (e.clientY - ds.startY) / zoom;
    onDragOrigin({ x: ds.originX + dx, y: ds.originY + dy });
  };
  const onPointerUp = () => {
    dragState.current = null;
  };

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

      {/* 分页原点拖动手柄 */}
      {result.pages.length > 0 && onDragOrigin ? (
        <div
          data-testid="page-origin-handle"
          className="pointer-events-auto absolute h-4 w-4 cursor-move rounded-full border-2 border-white bg-sky-500 shadow"
          style={{
            left: (result.pages[0]?.worldRect.x ?? 0) * zoom + vx,
            top: (result.pages[0]?.worldRect.y ?? 0) * zoom + vy,
            touchAction: 'none',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          title="拖动调整分页原点"
        />
      ) : null}
    </div>
  );
});
