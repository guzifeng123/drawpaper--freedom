import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  MarkerType,
  useReactFlow,
  type Connection,
  type IsValidConnection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import type { BlockNode, Edge as CoreEdge } from '@drawpaper/core';
import type { EditorApi } from '../editor-api';
import { EditorApiContext, useEditorSnapshot } from './editor-context';
import { nodeTypes, resolveNodeType } from '../nodes';
import { edgeTypes } from '../edges';
import { useKeyboardShortcuts } from '../state/useKeyboardShortcuts';
import { computeSnap } from '../lib/geometry';
import { ConflictDialog } from '../ui/ConflictDialog';
import { toast } from '../ui/toast';

/** 折叠节点的后代集合（折叠后映射给 React Flow 时剔除）。 */
function hiddenAfterCollapse(doc: { nodes: BlockNode[]; edges: CoreEdge[] }): Set<string> {
  const children = new Map<string, string[]>();
  for (const e of doc.edges) {
    children.set(e.source, [...(children.get(e.source) ?? []), e.target]);
  }
  const hidden = new Set<string>();
  for (const n of doc.nodes) {
    if (!n.collapsed) continue;
    const stack = [...(children.get(n.id) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (hidden.has(id)) continue;
      hidden.add(id);
      stack.push(...(children.get(id) ?? []));
    }
  }
  return hidden;
}

/** 一键整理幽灵节点（半透明 ghost 矩形，不动真节点）。 */
const LayoutGhostNode = memo(function LayoutGhostNode() {
  return (
    <div className="absolute inset-0 rounded-lg border-2 border-dashed border-blue-400 bg-blue-300/20" />
  );
});

const allNodeTypes = { ...nodeTypes, 'layout-ghost': LayoutGhostNode };

function CanvasInner({ api }: { api: EditorApi }) {
  const snap = useEditorSnapshot();
  const rf = useReactFlow();
  useKeyboardShortcuts(api);

  const [selectedEdgeIds, setSelectedEdgeIds] = useState<Set<string>>(new Set());
  const [guideLines, setGuideLines] = useState<{ orientation: 'vertical' | 'horizontal'; pos: number }[]>([]);
  const rafRef = useRef<number>(0);

  // 折叠过滤
  const hidden = useMemo(() => hiddenAfterCollapse(snap.doc), [snap.doc]);

  // 真节点 → RF nodes
  const rfNodes = useMemo(() => {
    const real = snap.doc.nodes
      .filter((n) => !hidden.has(n.id))
      .map((n) => ({
        id: n.id,
        type: resolveNodeType(n.type),
        position: { x: n.x, y: n.y },
        data: { block: n },
        selected: snap.selection.has(n.id),
        width: n.width,
        height: n.height,
      }));
    // 一键整理预览 ghost（叠加在世界坐标上）
    const ghosts = Object.entries(snap.layoutPreview ?? {}).map(([id, g]) => ({
      id: `ghost:${id}`,
      type: 'layout-ghost',
      position: { x: g.x, y: g.y },
      data: {},
      width: g.width,
      height: g.height,
    }));
    return [...real, ...ghosts];
  }, [snap.doc, snap.selection, hidden, snap.layoutPreview]);

  // 真边 → RF edges
  const rfEdges = useMemo(() => {
    return snap.doc.edges
      .filter((e) => !hidden.has(e.source) && !hidden.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        sourcePosition: e.sourceHandle,
        targetPosition: e.targetHandle,
        type: 'parent',
        selected: selectedEdgeIds.has(e.id),
        label: e.label,
        style: { stroke: e.style.color },
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: e.style.color },
      }));
  }, [snap.doc, hidden, selectedEdgeIds]);

  // 飞块：搜索/大纲 lastFocus → setCenter + 高亮
  useEffect(() => {
    const f = snap.lastFocus;
    if (!f) return;
    const n = snap.doc.nodes.find((x) => x.id === f.nodeId);
    if (!n) return;
    rf.setCenter(n.x + n.width / 2, n.y + n.height / 2, { zoom: Math.max(rf.getZoom(), 0.8), duration: 300 });
  }, [snap.lastFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  // 一键整理落位后：ghost 消失（应用/取消）时 fitView 让布局结果进入视野。
  const wasPreviewing = useRef(false);
  useEffect(() => {
    const previewing = !!snap.layoutPreview;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (wasPreviewing.current && !previewing) {
      // 等 250ms 落位动画结束再 fit。
      timer = setTimeout(() => rf.fitView({ padding: 0.2, duration: 300 }), 280);
    }
    wasPreviewing.current = previewing;
    return () => {
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.layoutPreview]);

  // 宏撤销（一键整理 confirm-layout / 对齐 / 裁决删边等全局位移）后回位相机：
  // 节点可能被 onlyRenderVisibleElements 卸载导致视野空，fitView 让结果重新入画。
  const lastHistoryNonce = useRef(0);
  useEffect(() => {
    const h = snap.historyEvent;
    if (!h || h.nonce === lastHistoryNonce.current) return;
    lastHistoryNonce.current = h.nonce;
    // 仅对全局位移类宏回位；单块增删/打字不跳相机。
    const macroNames = ['confirm-layout', 'align-selection', 'distribute-selection', 'resolve-conflicts'];
    if (h.kind === 'undo' && macroNames.includes(h.name)) {
      const timer = setTimeout(() => rf.fitView({ padding: 0.2, duration: 300 }), 60);
      return () => clearTimeout(timer);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.historyEvent]);

  // ---- 连接校验 ----
  const isValidConnection: IsValidConnection = (conn) => {
    if (conn.source && conn.target && conn.source === conn.target) return false;
    return true;
  };

  const onConnect = (conn: Connection) => {
    if (!conn.source || !conn.target) return;
    if (conn.source === conn.target) {
      toast('不能自己连自己');
      return;
    }
    const dup = snap.doc.edges.find((e) => e.source === conn.source && e.target === conn.target);
    if (dup) {
      setSelectedEdgeIds(new Set([dup.id]));
      toast('该父子关系已存在，已选中');
      return;
    }
    api.addEdge(conn.source, conn.target, {
      sourceHandle: (conn.sourceHandle as CoreEdge['sourceHandle']) ?? undefined,
      targetHandle: (conn.targetHandle as CoreEdge['targetHandle']) ?? undefined,
    });
  };

  const onConnectEnd = (event: MouseEvent | TouchEvent, connectionState: { fromNode?: { id: string } | null } | null) => {
    if (!connectionState?.fromNode) return;
    // 松手到空白：在松手坐标建新块并自动连父子边（串联爽点）
    const pos = rf.screenToFlowPosition({
      x: (event as MouseEvent).clientX,
      y: (event as MouseEvent).clientY,
    });
    const newId = api.addNode('text', pos.x - 110, pos.y - 30);
    api.addEdge(connectionState.fromNode.id, newId);
  };

  // ---- 节点变更（拖拽 / 选择）----
  const onNodesChange = (changes: NodeChange[]) => {
    for (const ch of changes) {
      if (ch.type === 'position' && ch.position && !ch.dragging) {
        api.moveNode(ch.id, ch.position.x, ch.position.y);
      } else if (ch.type === 'position' && ch.position && ch.dragging) {
        // 拖拽中：磁吸 + 参考线
        const others = snap.doc.nodes
          .filter((n) => n.id !== ch.id && !snap.selection.has(n.id))
          .map((n) => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height }));
        const moving = {
          x: ch.position.x,
          y: ch.position.y,
          width: snap.doc.nodes.find((n) => n.id === ch.id)?.width ?? 200,
          height: snap.doc.nodes.find((n) => n.id === ch.id)?.height ?? 60,
        };
        const snapRes = computeSnap(moving, others, { gridSnap: snap.prefs.gridSnap });
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => setGuideLines(snapRes.lines));
        api.moveNode(ch.id, ch.position.x + snapRes.dx, ch.position.y + snapRes.dy);
      } else if (ch.type === 'select') {
        const next = new Set(snap.selection);
        if (ch.selected) next.add(ch.id);
        else next.delete(ch.id);
        api.setSelection(next);
      }
    }
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    for (const ch of changes) {
      if (ch.type === 'select') {
        setSelectedEdgeIds((prev) => {
          const next = new Set(prev);
          if (ch.selected) next.add(ch.id);
          else next.delete(ch.id);
          return next;
        });
      }
    }
  };

  const mode = snap.mode;
  const selectionOnDrag = mode === 'select';
  const panOnDrag = mode === 'pan' ? true : [1, 2];

  // RF v22 不把 onDoubleClick/onContextMenu 透传到 pane；改用包装 div 上的原生监听。
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onDbl = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.react-flow__pane')) return;
      if (target.closest('.react-flow__node')) return;
      const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const id = api.addNode('text', pos.x - 110, pos.y - 30);
      api.setEditingNode(id);
    };
    const onCtx = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.react-flow__pane')) return;
      e.preventDefault();
      const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      if (window.confirm('在此新建块？确定 = 新建文本块，取消 = 不操作')) {
        const id = api.addNode('text', pos.x - 110, pos.y - 30);
        api.setEditingNode(id);
      }
    };
    el.addEventListener('dblclick', onDbl, true);
    el.addEventListener('contextmenu', onCtx, true);
    return () => {
      el.removeEventListener('dblclick', onDbl, true);
      el.removeEventListener('contextmenu', onCtx, true);
    };
  }, [api, rf]);

  return (
    <div className="relative h-full w-full" ref={wrapRef}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={allNodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onPaneClick={() => {
          api.setSelection([]);
          if (snap.editingNodeId) api.setEditingNode(null);
        }}
        onNodeClick={(_, node) => {
          if (snap.editingNodeId && snap.editingNodeId !== node.id) api.setEditingNode(null);
        }}
        onMove={(_, vp) => api.setViewport(vp)}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        onlyRenderVisibleElements
        selectionOnDrag={selectionOnDrag}
        panOnDrag={panOnDrag}
        panOnScroll={false}
        zoomOnScroll
        zoomOnPinch
        proOptions={{ hideAttribution: false }}
        defaultViewport={snap.viewport}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#cbd5e1" />
        <Controls position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeColor={(n) => (n.type === 'layout-ghost' ? '#93c5fd' : '#e2e8f0')}
        />

        {/* 对齐参考线 */}
        {guideLines.map((l, i) =>
          l.orientation === 'vertical' ? (
            <div key={i} className="pointer-events-none absolute top-0 bottom-0 w-px bg-blue-400" style={{ left: l.pos }} />
          ) : (
            <div key={i} className="pointer-events-none absolute left-0 right-0 h-px bg-blue-400" style={{ top: l.pos }} />
          ),
        )}

        {/* 右下角自建缩放控件（百分比 + 适应/100%） */}
        <Panel position="bottom-right" className="!mb-16 mr-2 flex items-center gap-1 rounded border bg-white px-1 py-0.5 text-[10px] shadow">
          <button className="px-1" onClick={() => rf.zoomOut()}>
            −
          </button>
          <button className="w-12 text-center" onClick={() => rf.fitView({ duration: 200 })} title="适应屏幕">
            {Math.round(snap.viewport.zoom * 100)}%
          </button>
          <button className="px-1" onClick={() => rf.zoomIn()}>
            +
          </button>
          <button className="px-1" onClick={() => rf.setViewport({ x: snap.viewport.x, y: snap.viewport.y, zoom: 1 }, { duration: 200 })} title="实际大小">
            1:1
          </button>
        </Panel>
      </ReactFlow>

      <ConflictDialog />
    </div>
  );
}

/**
 * CanvasEditor —— 画布编辑主组件（Wave1-D）。
 * 用法：<CanvasEditor api={createMockEditorApi()} />
 */
export function CanvasEditor({ api }: { api: EditorApi }) {
  return (
    <EditorApiContext.Provider value={api}>
      <ReactFlowProvider>
        <CanvasInner api={api} />
      </ReactFlowProvider>
    </EditorApiContext.Provider>
  );
}
