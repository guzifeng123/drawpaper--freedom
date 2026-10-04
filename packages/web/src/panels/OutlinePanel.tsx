import * as React from 'react';
import {
  buildMainTree,
  findOrphans,
  type BlockNode,
  type MainTree,
} from '@drawpaper/core';
import {
  ChevronRight,
  ChevronDown,
  GripVertical,
  Plus,
  Search,
  FileText,
  Heading,
  CheckSquare,
  List,
  Image as ImageIcon,
  StickyNote,
  Folder,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { PanelsApi } from './panels-api';
import {
  canReparent,
  resolveReparentTarget,
  positionFromPointerRatio,
  type DropPosition,
} from './lib/outline-dnd';
import { useToast } from './lib/toast';

const TYPE_ICON: Record<BlockNode['type'], React.ComponentType<{ className?: string }>> = {
  text: FileText,
  heading: Heading,
  todo: CheckSquare,
  bullet: List,
  image: ImageIcon,
  note: StickyNote,
  group: Folder,
  table: FileText,
  code: FileText,
  equation: FileText,
  bookmark: FileText,
  attachment: FileText,
  reminder: FileText,
};

/** 从 Tiptap JSON 提取纯文本（与搜索索引同一提取器）。 */
function plainText(node: BlockNode): string {
  const parts: string[] = [];
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    const n = v as { text?: unknown; content?: unknown };
    if (typeof n.text === 'string') parts.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(node.content.data);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

interface DropState {
  dragId: string;
  targetId: string | null;
  position: DropPosition | null;
}

interface RowProps {
  node: BlockNode;
  depth: number;
  tree: MainTree;
  api: PanelsApi;
  selectedId: string | null;
  visible: boolean;
  drop: DropState | null;
  onRowPointerDown: (e: React.PointerEvent, nodeId: string) => void;
  onRowPointerMove: (e: React.PointerEvent, nodeId: string) => void;
  onAddChild: (parentId: string, text: string) => void;
  childComposerFor: string | null;
  setChildComposerFor: (id: string | null) => void;
}

const INDENT = 16;

function OutlineRow({
  node,
  depth,
  tree,
  api,
  selectedId,
  visible,
  drop,
  onRowPointerDown,
  onRowPointerMove,
  onAddChild,
  childComposerFor,
  setChildComposerFor,
}: RowProps) {
  const toast = useToast();
  const tn = tree.nodes[node.id];
  const children = tn?.children ?? [];
  const hasChildren = children.length > 0;
  const text = plainText(node) || '（空块）';
  const Icon = TYPE_ICON[node.type] ?? FileText;
  const rowRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (selectedId === node.id) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, node.id]);

  const isDropTarget = drop?.targetId === node.id && drop.position !== null;
  const isDraggingSelf = drop?.dragId === node.id;

  if (!visible) return null;

  const tagColors = node.tags
    .map((tid) => api.tags.find((t) => t.id === tid)?.color)
    .filter((c): c is string => !!c);

  return (
    <div>
      <div
        ref={rowRef}
        data-outline-row-id={node.id}
        className={cn(
          'group relative flex items-center gap-0.5 rounded pr-1 text-sm',
          node.id === selectedId ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
          isDraggingSelf && 'opacity-40',
        )}
        style={{ paddingLeft: depth * INDENT + 2 }}
        onMouseEnter={() => api.flyToNode(node.id)}
        onClick={() => api.flyToNode(node.id)}
        onPointerMove={(e) => onRowPointerMove(e, node.id)}
      >
        {/* 拖拽手柄 */}
        <span
          role="button"
          aria-label="拖拽调整层级"
          className="cursor-grab rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 active:cursor-grabbing"
          onPointerDown={(e) => onRowPointerDown(e, node.id)}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
        {/* 折叠箭头：有子女才渲染按钮，否则占位保持对齐 */}
        {hasChildren ? (
          <button
            type="button"
            aria-label={node.collapsed ? '展开分支' : '折叠分支'}
            className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              api.toggleCollapseNode(node.id);
            }}
          >
            {node.collapsed ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate py-1">{text}</span>
        {/* 标签色点 */}
        {tagColors.map((c, i) => (
          <span
            key={`${c}-${i}`}
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: c }}
          />
        ))}
        {hasChildren ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">{children.length}</span>
        ) : null}
        {/* 行尾 + 新建子块 */}
        <button
          type="button"
          aria-label="新建子块"
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            setChildComposerFor(childComposerFor === node.id ? null : node.id);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        {/* 拖拽引导线：before=顶线 / after=底线 / child=左竖线 */}
        {isDropTarget && drop.position === 'before' ? (
          <span className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded bg-primary" />
        ) : null}
        {isDropTarget && drop.position === 'after' ? (
          <span className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded bg-primary" />
        ) : null}
        {isDropTarget && drop.position === 'child' ? (
          <span
            className="pointer-events-none absolute bottom-0.5 top-0.5 w-0.5 rounded bg-primary"
            style={{ left: depth * INDENT + 12 }}
          />
        ) : null}
      </div>

      {/* 内联新建子块输入 */}
      {childComposerFor === node.id ? (
        <div style={{ paddingLeft: (depth + 1) * INDENT + 22 }}>
          <InlineComposer
            placeholder="输入子块内容，Enter 确认…"
            onSubmit={(text) => {
              onAddChild(node.id, text);
              setChildComposerFor(null);
              toast.success('已新建子块');
            }}
            onCancel={() => setChildComposerFor(null)}
          />
        </div>
      ) : null}

      {/* 子节点（折叠时不渲染） */}
      {!node.collapsed
        ? children.map((cid) => {
            const childNode = api.doc?.nodes.find((n) => n.id === cid);
            if (!childNode) return null;
            return (
              <OutlineRow
                key={cid}
                node={childNode}
                depth={depth + 1}
                tree={tree}
                api={api}
                selectedId={selectedId}
                visible={visible}
                drop={drop}
                onRowPointerDown={onRowPointerDown}
                onRowPointerMove={onRowPointerMove}
                onAddChild={onAddChild}
                childComposerFor={childComposerFor}
                setChildComposerFor={setChildComposerFor}
              />
            );
          })
        : null}
    </div>
  );
}

function InlineComposer({
  placeholder,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = React.useState('');
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    requestAnimationFrame(() => ref.current?.focus());
  }, []);
  return (
    <Input
      ref={ref}
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSubmit(value);
        if (e.key === 'Escape') onCancel();
      }}
      className="my-0.5 h-7 px-1.5 text-xs"
    />
  );
}

/**
 * 大纲面板（Wave3-H §4.7）：
 * - 由父子边经 core buildMainTree 生成可折叠树；游离块归入底部「未分组」；
 * - 选中节点变化 → 高亮并滚动可见；悬停/点击条目 → api.flyToNode；
 * - 拖拽手柄改缩进 = 改父子关系（api.reparentNode）；
 * - 条目尾「+」内联输入新建子块；底部根级输入新建块；
 * - 搜索过滤本树文本（匹配节点的祖先链保持可见）。
 */
export const OutlinePanel = React.memo(function OutlinePanel({ api }: { api: PanelsApi }) {
  const [query, setQuery] = React.useState('');
  const [drop, setDrop] = React.useState<DropState | null>(null);
  const [childComposerFor, setChildComposerFor] = React.useState<string | null>(null);
  const dragState = React.useRef<{ id: string } | null>(null);
  const toast = useToast();

  const doc = api.doc;
  const nodes = React.useMemo(() => doc?.nodes ?? [], [doc]);
  const edges = React.useMemo(() => doc?.edges ?? [], [doc]);

  const tree = React.useMemo(() => buildMainTree(nodes, edges), [nodes, edges]);
  const orphanIds = React.useMemo(() => new Set(findOrphans(nodes, edges)), [nodes, edges]);
  const treeRoots = React.useMemo(
    () => tree.roots.filter((id) => !orphanIds.has(id)),
    [tree, orphanIds],
  );
  const orphanNodes = React.useMemo(
    () => nodes.filter((n) => orphanIds.has(n.id)),
    [nodes, orphanIds],
  );

  // 搜索过滤：命中节点 + 其祖先链可见
  const filter = query.trim().toLowerCase();
  const visibleSet = React.useMemo(() => {
    if (!filter) return null; // null = 不过滤
    const hit = new Set<string>();
    for (const n of nodes) {
      if (plainText(n).toLowerCase().includes(filter)) hit.add(n.id);
    }
    // 祖先链：向上挂到父
    const visible = new Set(hit);
    for (const id of hit) {
      let cur: string | null = tree.nodes[id]?.parentId ?? null;
      let guard = 0;
      while (cur && guard++ < 1000) {
        visible.add(cur);
        cur = tree.nodes[cur]?.parentId ?? null;
      }
    }
    return visible;
  }, [filter, nodes, tree]);

  const selectedId = api.selectedNodeIds[0] ?? null;

  // ---- 指针拖拽 ----
  const handleRowPointerDown = React.useCallback(
    (e: React.PointerEvent, nodeId: string) => {
      e.preventDefault();
      dragState.current = { id: nodeId };
      setDrop({ dragId: nodeId, targetId: null, position: null });

      const onMove = (ev: PointerEvent) => {
        const target = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest<HTMLElement>('[data-outline-row-id]');
        if (!target?.dataset.outlineRowId) {
          setDrop({ dragId: nodeId, targetId: null, position: null });
          return;
        }
        const targetId = target.dataset.outlineRowId;
        const rect = target.getBoundingClientRect();
        const ratioY = (ev.clientY - rect.top) / rect.height;
        const position = positionFromPointerRatio(ratioY);
        const valid =
          nodeId !== targetId && canReparent(tree, nodeId, targetId, position);
        setDrop({ dragId: nodeId, targetId: valid ? targetId : null, position: valid ? position : null });
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const target = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest<HTMLElement>('[data-outline-row-id]');
        const targetId = target?.dataset.outlineRowId;
        if (target && targetId) {
          const rect = target.getBoundingClientRect();
          const position = positionFromPointerRatio((ev.clientY - rect.top) / rect.height);
          const resolved = resolveReparentTarget(tree, nodeId, targetId, position);
          if (resolved) {
            api.reparentNode(nodeId, resolved.newParentId, resolved.index);
          } else if (nodeId !== targetId) {
            toast.warn('不能拖到自己的分支内');
          }
        }
        dragState.current = null;
        setDrop(null);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [api, tree, toast],
  );

  const noopMove = React.useCallback(() => undefined, []);

  if (!doc) {
    return (
      <aside className="absolute left-60 top-16 z-10 flex w-64 flex-col rounded-lg border bg-card/95 shadow-sm">
        <div className="px-3 py-2 text-xs text-muted-foreground">打开文档后显示大纲</div>
      </aside>
    );
  }

  const renderRow = (node: BlockNode, depth: number) => (
    <OutlineRow
      key={node.id}
      node={node}
      depth={depth}
      tree={tree}
      api={api}
      selectedId={selectedId}
      visible={visibleSet ? visibleSet.has(node.id) : true}
      drop={drop}
      onRowPointerDown={handleRowPointerDown}
      onRowPointerMove={noopMove}
      onAddChild={(parentId, text) => api.addChildBlock(parentId, text)}
      childComposerFor={childComposerFor}
      setChildComposerFor={setChildComposerFor}
    />
  );

  return (
    <aside className="absolute left-60 top-16 z-10 flex w-64 flex-col rounded-lg border bg-card/95 shadow-sm">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <span className="text-xs font-semibold text-muted-foreground">大纲</span>
        <div className="relative ml-auto flex-1 max-w-32">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="过滤…"
            className="h-6 w-full rounded border-0 bg-transparent pl-5 pr-1 text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <ScrollArea className="flex-1 p-1">
        {nodes.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            画布还是空的
          </div>
        ) : (
          <>
            {treeRoots.length === 0 && orphanNodes.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                暂无层级结构
              </div>
            ) : null}
            {treeRoots.map((id) => {
              const node = nodes.find((n) => n.id === id);
              return node ? renderRow(node, 0) : null;
            })}

            {orphanNodes.length > 0 ? (
              <div className="mt-2 border-t pt-1">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  未分组（{orphanNodes.length}）
                </div>
                {orphanNodes.map((n) => renderRow(n, 0))}
              </div>
            ) : null}

            {/* 根级新建块：按钮展开为输入 */}
            <RootComposer
              onSubmit={(text) => {
                api.addChildBlock(null, text);
                toast.success('已新建块');
              }}
            />
          </>
        )}
      </ScrollArea>
    </aside>
  );
});

/** 根级新建块：默认是一行虚线按钮，点击后展开为输入框。 */
function RootComposer({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [open, setOpen] = React.useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className="mt-1 flex w-full items-center gap-1 rounded border border-dashed px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <Plus className="h-3 w-3" /> 新建根级块
      </button>
    );
  }
  return (
    <div className="mt-1">
      <InlineComposer
        placeholder="输入块内容，Enter 确认…"
        onSubmit={(text) => {
          onSubmit(text);
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}
