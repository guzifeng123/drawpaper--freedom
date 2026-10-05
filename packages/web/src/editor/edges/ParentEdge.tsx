import { memo, useRef, useState, useEffect } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  useStore,
  useReactFlow,
  type EdgeProps,
} from '@xyflow/react';
import { EDGE_COLORS, DEFAULT_EDGE_COLOR } from '@drawpaper/core';
import { useEditorApi } from '../canvas/editor-context';
import { ArrowLeftRight, Trash2 } from 'lucide-react';
import {
  buildEdgePath,
  edgeMidpoint,
  type EdgeEnd,
} from './edge-geometry';
import { setActiveBendAnchor } from './bend-active';
import { getBendMenu, setBendMenu, subscribeBendMenu } from './bend-menu';

interface BendPoint {
  x: number;
  y: number;
}

/**
 * ParentEdge —— 唯一的边类型：有向父子边（带实心箭头）。
 *
 * 弯折点（P2.1 打磨）：
 * - 双击边路径（非锚点）：在光标世界坐标处插入一个弯折点（走 setEdgePoints，可撤销）；
 * - 选中边时中点出现拖拽手柄（无 points 时拖出第一个弯折点）；
 * - 已有弯折点逐点显示为小锚点（热区 ≥24px），可拖动改位；
 * - 键盘删除：点中某个锚点后按 Delete/Backspace 只删该锚点（不再清空全部弯折）；
 *   边被选中但未选中锚点时 Delete 仍删边（RF 原生）；points 清空后恢复贝塞尔；
 * - 多选边时浮动工具条出现「清除弯折点」，对每条选中边 setEdgePoints([])（一次可撤销宏）；
 * - 右键锚点弹出小菜单：删除此弯折点。
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
  // 右键锚点小菜单（模块级单例，避免重挂载丢 state）。
  const [menu, setMenuLocal] = useState(() => getBendMenu());
  useEffect(() => subscribeBendMenu(() => setMenuLocal(getBendMenu())), []);

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
    // 右键（button===2）：不 preventDefault / 不捕获指针 / 不进入拖拽，否则浏览器
    // contextmenu 不触发，右键菜单弹不出。右键只用于弹菜单（onContextMenu 处理）。
    if (e.button === 2) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    // 登记「激活锚点」：全局 Delete 据此只删这一个点（idx===null 的中点手柄不登记）
    if (idx !== null) setActiveBendAnchor({ edgeId: id, index: idx });
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
      next.length = 0;
      next.push(pos);
    } else {
      next[d.idx] = pos;
    }
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

  // 删第 idx 个弯折点（右键菜单 / 双击锚点共用）
  const deletePoint = (idx: number) => {
    const next = points.filter((_, i) => i !== idx);
    setActiveBendAnchor(null);
    setBendMenu(null);
    api.setEdgePoints?.(id, next);
  };

  // 多选边一键清除：对每条选中边清空 points（core 侧合并为一次可撤销宏）
  const onClearAllBends = () => {
    const ids = selectedEdges.length > 1 ? selectedEdges.map((e) => e.id) : [id];
    api.clearEdgesPoints?.(ids);
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
          <div style={{ position: 'absolute', inset: 0 }} className="nodrag nopan pointer-events-none">
            {/* 中点手柄（无 points 时拖出第一个弯折点；有 points 时作为加新点入口） */}
            <div
              data-testid="edge-bend-midpoint"
              title="拖动新增弯折点；双击边路径也可加点"
              onPointerDown={(e) => onHandlePointerDown(e, null)}
              onPointerMove={onHandlePointerMove}
              onPointerUp={onHandlePointerUp}
              className="nodrag nopan pointer-events-auto absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-crosshair items-center justify-center"
              style={{ left: mid.x, top: mid.y }}
            >
              <span className="block h-3 w-3 rounded-full border border-blue-400 bg-white shadow" />
            </div>
            {/* 既有弯折点（热区 24px = h-6 w-6，视觉圆点 14px） */}
            {renderPoints.map((p, i) => (
              <div
                key={i}
                data-testid="edge-bend-anchor"
                title={`弯折点 #${i + 1}：拖动改位；右键删除；Delete 键删此点`}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  deletePoint(i);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setActiveBendAnchor({ edgeId: id, index: i });
                  setBendMenu({ edgeId: id, index: i, x: p.x, y: p.y });
                }}
                onPointerDown={(e) => onHandlePointerDown(e, i)}
                onPointerMove={onHandlePointerMove}
                onPointerUp={onHandlePointerUp}
                className="nodrag nopan pointer-events-auto absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center"
                style={{ left: p.x, top: p.y }}
              >
                <span className="block h-3.5 w-3.5 rounded-full border-2 border-blue-500 bg-blue-100 shadow" />
              </div>
            ))}
            {/* 右键锚点小菜单（轻量自制，无新依赖） */}
            {menu && menu.edgeId === id && (
              <div
                className="nodrag nopan pointer-events-auto absolute"
                style={{ left: menu.x, top: menu.y, transform: 'translate(12px, 12px)' }}
              >
                <div className="rounded-md border bg-white py-1 shadow-lg">
                  <button
                    data-testid="edge-bend-menu-delete"
                    className="flex w-full items-center gap-1 px-3 py-1 text-left text-xs text-slate-700 hover:bg-slate-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      deletePoint(menu.index);
                    }}
                  >
                    <Trash2 size={12} /> 删除此弯折点
                  </button>
                  <button
                    className="w-full px-3 py-1 text-left text-xs text-slate-400 hover:bg-slate-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      setBendMenu(null);
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        </EdgeLabelRenderer>
      )}

      {/* 边色板 + 反转（选中且未降透明时浮在边中点）；多选时追加「清除弯折点」 */}
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
            {/* 多选边时才出现：一键清除全部选中边的弯折点（一次可撤销宏） */}
            {selectedEdges.length > 1 && (
              <>
                <span className="mx-0.5 h-3 w-px bg-slate-200" />
                <button
                  data-testid="edge-clear-bends"
                  title="清除所有选中边的弯折点（恢复贝塞尔）"
                  className="flex items-center gap-0.5 rounded p-0.5 text-[10px] text-slate-500 hover:text-blue-600"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClearAllBends();
                  }}
                >
                  <Trash2 size={12} /> 清除弯折
                </button>
              </>
            )}
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
