import { memo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useStore, type EdgeProps } from '@xyflow/react';
import { EDGE_COLORS, DEFAULT_EDGE_COLOR } from '@drawpaper/core';
import { useEditorApi } from '../canvas/editor-context';
import { ArrowLeftRight } from 'lucide-react';

/**
 * ParentEdge —— 唯一的边类型：带实心箭头的贝塞尔有向父子边。
 * - 颜色取 edge.style.stroke（映射自 core EDGE_COLORS）
 * - 选中加粗 + 6 色浮层；多选时色板批量改色（P1 §4.3）
 * - 反转方向按钮（api.reverseEdge，含句柄位交换）
 * - 自由文字标签：双击标签弹小 input，提交 api.setEdgeLabel
 * - data.dimmed：悬停高亮/聚焦/筛选降透明时隐藏浮层
 */

export const ParentEdge = memo(function ParentEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, markerEnd, data } = props;
  const api = useEditorApi();
  const [label, setLabel] = useState<string>(typeof props.label === 'string' ? props.label : '');
  const [editingLabel, setEditingLabel] = useState(false);

  // 选中的全部边（多选批量改色用）
  const selectedEdges = useStore((s) => s.edges.filter((e) => e.selected));
  const dimmed = (data as { dimmed?: boolean } | undefined)?.dimmed ?? false;

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const color = (props.style?.stroke as string | undefined) ?? DEFAULT_EDGE_COLOR.hex;

  const applyColor = (hex: string) => {
    // 多选时批量改色；仅当前边被选中时改自己
    const targets = selectedEdges.length > 1 ? selectedEdges.map((e) => e.id) : [id];
    for (const eid of targets) api.setEdgeColor(eid, hex);
  };

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: color,
          strokeWidth: selected ? 3 : 1.8,
        }}
      />

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
