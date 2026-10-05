import { memo, useRef, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  useStore,
  useReactFlow,
  type EdgeProps,
} from '@xyflow/react';
import { EDGE_COLORS, DEFAULT_EDGE_COLOR } from '@drawpaper/core';
import { useEditorApi } from '../canvas/editor-context';
import { ArrowLeftRight } from 'lucide-react';
import { buildEdgePath, edgeMidpoint, type EdgeEnd } from './edge-geometry';

interface BendPoint {
  x: number;
  y: number;
}

/**
 * ParentEdge —— 唯一的边类型：有向父子边（带实心箭头）。
 *
 * 弯折点（P2 §4.3）：
 * - 选中边时，中点出现拖拽手柄（无 points 时拖出第一个弯折点）；
 * - 已有弯折点逐点显示为小圆手柄，可拖动改位、双击删除；
 * - 选中锚点后按 Delete/Backspace = 清空全部弯折点恢复贝塞尔（与「删边」区分：
 *   未锚定选中时 Delete 仍走 RF 原生删边）。
 * - points 世界坐标经 data.points 透传；api.setEdgePoints 可撤销持久化。
 */

export const ParentEdge = memo(function ParentEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    selected,
    markerEnd,
    data,
  } = props;
  const api = useEditorApi();
  const rf = useReactFlow();
  const [label, setLabel] = useState<string>(typeof props.label === 'string' ? props.label : '');
  const [editingLabel, setEditingLabel] = useState(false);
  const [pointActive, setPointActive] = useState(false);

  const selectedEdges = useStore((s) => s.edges.filter((e) => e.selected));
  const dimmed = (data as { dimmed?: boolean } | undefined)?.dimmed ?? false;
  const points = ((data as { points?: BendPoint[] } | undefined)?.points ?? []).filter((p) =>
    Number.isFinite(p.x) && Number.isFinite(p.y),
  );

  const s: EdgeEnd = { x: sourceX, y: sourceY, position: sourcePosition as EdgeEnd['position'] };
  const t: EdgeEnd = { x: targetX, y: targetY, position: targetPosition as EdgeEnd['position'] };
  const mid = edgeMidpoint(s, t);

  const color = (props.style?.stroke as string | undefined) ?? DEFAULT_EDGE_COLOR.hex;
  const labelX = mid.x;
  const labelY = mid.y;

  const applyColor = (hex: string) => {
    const targets = selectedEdges.length > 1 ? selectedEdges.map((e) => e.id) : [id];
    for (const eid of targets) api.setEdgeColor(eid, hex);
  };

  // ---- 弯折点拖拽 ----
  const drag = useRef<{ idx: number | null; startX: number; startY: number; base: BendPoint[] } | null>(null);

  const onHandlePointerDown = (e: React.PointerEvent, idx: number | null) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setPointActive(true);
    drag.current = {
      idx, // null = 从 midpoint 新建
      startX: e.clientX,
      startY: e.clientY,
      base: points.map((p) => ({ ...p })),
    };
  };
  const onHandlePointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const next = d.base.map((p) => ({ ...p }));
    if (d.idx === null) {
      // midpoint 手柄：拖到的位置即新建弯折点（先占位 1 个点）
      next.length = 0;
      next.push(pos);
    } else {
      next[d.idx] = pos;
    }
    // 拖拽中实时预览（非持久化，松手才 commit）
    setLivePath(next);
  };
  const onHandlePointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const next = d.base.map((p) => ({ ...p }));
    if (d.idx === null) {
      next.length = 0;
      next.push(pos);
    } else {
      next[d.idx] = pos;
    }
    setLivePath(null);
    drag.current = null;
    api.setEdgePoints?.(id, next);
  };

  // 拖拽中实时预览的 path（松手后由 data.points 驱动）
  const [live, setLivePath] = useState<BendPoint[] | null>(null);
  const renderPoints = live ?? points;
  const renderPath = buildEdgePath(s, t, renderPoints);

  // 双击锚点删除该点
  const deletePoint = (idx: number) => {
    const next = points.filter((_, i) => i !== idx);
    api.setEdgePoints?.(id, next);
  };

  // Delete/Backspace：锚点激活时清空弯折点（而非删边）
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (pointActive && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      e.stopPropagation();
      api.setEdgePoints?.(id, []);
      setPointActive(false);
    }
  };

  return (
    <>
      <BaseEdge
        id={id}
        path={renderPath}
        markerEnd={markerEnd}
        style={{ stroke: color, strokeWidth: selected ? 3 : 1.8 }}
      />

      {/* 选中：中点手柄 + 既有弯折点手柄 */}
      {selected && !dimmed && (
        <EdgeLabelRenderer>
          <div
            tabIndex={-1}
            onKeyDown={onKeyDown}
            style={{ position: 'absolute', inset: 0 }}
            className="nodrag nopan"
          >
            {/* 中点手柄（无 points 时拖出第一个弯折点；有 points 时作为加新点入口） */}
            <div
              title="拖动新增弯折点；选中锚点后按 Delete 清空弯折"
              onPointerDown={(e) => onHandlePointerDown(e, null)}
              onPointerMove={onHandlePointerMove}
              onPointerUp={onHandlePointerUp}
              className="nodrag nopan absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-full border border-blue-400 bg-white shadow"
              style={{ left: mid.x, top: mid.y }}
            />
            {/* 既有弯折点 */}
            {renderPoints.map((p, i) => (
              <div
                key={i}
                title={`弯折点 #${i + 1}：拖动改位，双击删除`}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  deletePoint(i);
                }}
                onPointerDown={(e) => onHandlePointerDown(e, i)}
                onPointerMove={onHandlePointerMove}
                onPointerUp={onHandlePointerUp}
                className="nodrag nopan absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-blue-500 bg-blue-100 shadow"
                style={{ left: p.x, top: p.y }}
              />
            ))}
          </div>
        </EdgeLabelRenderer>
      )}

      {/* 边色板 + 反转（选中且未降透明时浮在边中点） */}
      {selected && !dimmed && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute flex items-center gap-1 rounded-full border bg-white px-1.5 py-1 shadow-md"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {[...EDGE_COLORS, DEFAULT_EDGE_COLOR].map((c) => (
              <button
                key={c.key}
                title={c.name}
                className="h-3.5 w-3.5 rounded-full border border-slate-200"
                style={{ background: c.hex }}
                onClick={(e) => {
                  e.stopPropagation();
                  applyColor(c.hex);
                }}
              />
            ))}
            <span className="mx-0.5 h-3 w-px bg-slate-200" />
            <button
              title="反转方向"
              className="rounded p-0.5 text-slate-500 hover:text-blue-600"
              onClick={(e) => {
                e.stopPropagation();
                api.reverseEdge?.(id);
              }}
            >
              <ArrowLeftRight size={12} />
            </button>
          </div>
        </EdgeLabelRenderer>
      )}

      {/* 自由文字标签 */}
      {label && !editingLabel ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute rounded bg-white/90 px-1 text-[10px] text-slate-600 shadow-sm"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditingLabel(true);
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
      {editingLabel ? (
        <EdgeLabelRenderer>
          <input
            autoFocus
            className="nodrag nopan absolute w-24 rounded border border-blue-300 px-1 text-[10px]"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => {
              api.setEdgeLabel(id, label);
              setEditingLabel(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                api.setEdgeLabel(id, label);
                setEditingLabel(false);
              }
              if (e.key === 'Escape') setEditingLabel(false);
            }}
          />
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});
