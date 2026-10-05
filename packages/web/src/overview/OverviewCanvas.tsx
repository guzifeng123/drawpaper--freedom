import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  aggregateOverview,
  computeView,
  expandDoc,
  collapseDoc,
  maybeCollapseForScale,
  layoutOverviewView,
  searchOverview,
  type OverviewModel,
  type OverviewDocInput,
} from '@drawpaper/core';
import type { KBNoteDoc } from '@drawpaper/core';
import type { OverviewProvider } from './types';
import { docColor } from './types';
import { extractBlockLabel } from './text';

export interface OverviewCanvasProps {
  provider: OverviewProvider;
  /** 点击块节点 → Wave7 接 openDoc + flyTo + 高亮。 */
  onOpenDocNode?: (docId: string, nodeId: string) => void;
  /** 顶部关闭回调（可选，由宿主面板提供）。 */
  onClose?: () => void;
}

/** 把 KBNoteDoc 转成 overview 聚合输入。 */
function toOverviewInput(doc: KBNoteDoc): OverviewDocInput {
  return {
    id: doc.id,
    title: doc.title,
    nodes: doc.nodes.map((n) => ({ id: n.id, type: n.type, label: extractBlockLabel(n) })),
    edges: doc.edges,
    links: doc.links ?? [],
  };
}

function OverviewInner({ provider, onOpenDocNode, onClose }: OverviewCanvasProps) {
  const [model, setModel] = useState<OverviewModel | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [autoCollapsed, setAutoCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    provider.loadAllDocs().then((docs) => {
      if (cancelled) return;
      const m = aggregateOverview(docs.map(toOverviewInput));
      setModel(m);
      // 大图：超阈值自动折叠到文档簇。
      const { view, collapsed } = maybeCollapseForScale(m, new Set());
      if (collapsed) {
        setCollapsed(new Set(view.collapsedDocIds));
        setAutoCollapsed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const view = useMemo(() => (model ? computeView(model, collapsed) : null), [model, collapsed]);
  const positions = useMemo(() => (view ? layoutOverviewView(view) : {}), [view]);

  const search = useMemo(() => (model && query ? searchOverview(model, query) : null), [model, query]);
  const matchedSet = useMemo(() => new Set(search?.matchedBlockIds ?? []), [search]);
  const recommendSet = useMemo(() => new Set(search?.recommendedDocIds ?? []), [search]);

  const rfNodes: Node[] = useMemo(() => {
    if (!view || !model) return [];
    const allDocIds = model.docs.map((d) => d.docId);
    return view.nodes.map((n) => {
      const pos = positions[n.id] ?? { x: 0, y: 0 };
      const color = docColor(n.docId, allDocIds);
      const isCluster = n.kind === 'doc';
      // 搜索时：命中块高亮描边，未命中块降透明。
      const dimmed = search ? !matchedSet.has(n.id) && !recommendSet.has(n.docId) && !isCluster : false;
      return {
        id: n.id,
        position: { x: pos.x, y: pos.y },
        data: {
          label: n.title,
          docId: n.docId,
          isCluster,
        },
        style: {
          background: color,
          border: matchedSet.has(n.id) ? '2px solid #2563EB' : `2px solid ${color}`,
          borderRadius: isCluster ? 12 : 8,
          padding: 8,
          fontSize: isCluster ? 14 : 12,
          fontWeight: isCluster ? 700 : 400,
          opacity: dimmed ? 0.25 : 1,
          minWidth: isCluster ? 140 : 120,
        },
        className: isCluster ? 'overview-cluster-node' : 'overview-block-node',
      };
    });
  }, [view, model, positions, search, matchedSet, recommendSet]);

  const rfEdges: Edge[] = useMemo(() => {
    if (!view) return [];
    return view.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: e.type === 'docref',
      style: {
        stroke: e.type === 'docref' ? '#94A3B8' : '#CBD5E1',
        strokeWidth: e.type === 'docref' ? 2 : 1,
        strokeDasharray: e.type === 'docref' ? '6 4' : undefined,
      },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    }));
  }, [view]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      const id = node.id;
      if (id.startsWith('d:')) {
        // 文档簇 → 展开/折叠
        const docId = id.slice(2);
        setCollapsed((prev) =>
          collapsed.has(docId) ? expandDoc(prev, docId) : collapseDoc(prev, docId),
        );
      } else {
        // 块节点 → 打开文档并跳转
        const m = /^b:(.+)::(.+)$/.exec(id);
        if (m && m[1] && m[2] && onOpenDocNode) onOpenDocNode(m[1], m[2]);
      }
    },
    [collapsed, onOpenDocNode],
  );

  if (!view) {
    return (
      <div className="overview-loading" data-testid="overview-loading">
        加载总览…
      </div>
    );
  }

  return (
    <div className="relative h-full w-full" data-testid="overview-canvas">
      <div className="absolute left-2 top-2 z-10 flex items-center gap-2">
        <input
          data-testid="overview-search"
          placeholder="搜索标题 / 块文本…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        />
        {autoCollapsed && (
          <span className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-700">
            节点较多，已按文档聚合
          </span>
        )}
        <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-500">
          虚线 = 跨文档双链
        </span>
        <button
          data-testid="overview-collapse-all"
          onClick={() => setCollapsed(new Set(model?.docs.map((d) => d.docId) ?? []))}
          className="rounded border px-2 py-1 text-xs"
        >
          折叠全部
        </button>
        <button
          data-testid="overview-expand-all"
          onClick={() => setCollapsed(new Set())}
          className="rounded border px-2 py-1 text-xs"
        >
          展开全部
        </button>
        {onClose && (
          <button onClick={onClose} className="rounded border px-2 py-1 text-sm">
            关闭
          </button>
        )}
      </div>

      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodeClick={onNodeClick}
        onlyRenderVisibleElements
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

export function OverviewCanvas(props: OverviewCanvasProps) {
  return (
    <ReactFlowProvider>
      <OverviewInner {...props} />
    </ReactFlowProvider>
  );
}
