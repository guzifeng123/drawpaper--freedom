import { memo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { EDGE_COLORS, DEFAULT_EDGE_COLOR } from '@drawpaper/core';
import { useEditorApi } from '../canvas/editor-context';

/**
 * ParentEdge —— 唯一的边类型：带实心箭头的贝塞尔有向父子边。
 * - 颜色取 edge.style.stroke（映射自 core EDGE_COLORS）
 * - 选中加粗 + 6 色浮层（core EDGE_COLORS/DEFAULT_EDGE_COLOR，禁止硬编码别的色值）
 * - 自由文字标签：双击标签弹小 input，提交 api.setEdgeLabel
 */

export const ParentEdge = memo(function ParentEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, markerEnd } = props;
  const api = useEditorApi();
  const [label, setLabel] = useState<string>(typeof props.label === 'string' ? props.label : '');
  const [editingLabel, setEditingLabel] = useState(false);

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const color = (props.style?.stroke as string | undefined) ?? DEFAULT_EDGE_COLOR.hex;
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

      {/* 边色板（选中时浮在边中点） */}
      {selected && (
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
                  api.setEdgeColor(id, c.hex);
                }}
              />
            ))}
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
