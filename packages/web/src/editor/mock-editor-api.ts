import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type {
  BlockNode,
  Edge,
  InteractionMode,
  KBNoteDoc,
  Viewport,
  BlockType,
} from '@drawpaper/core';
import {
  DOC_FORMAT,
  CURRENT_DOC_VERSION,
  DEFAULT_EDGE_COLOR,
} from '@drawpaper/core';
import type {
  ConflictResolutionInput,
  EditorApi,
  EditorSnapshot,
  LayoutGhost,
  PendingConflicts,
} from './editor-api';
import { DEFAULT_NODE_SIZE, defaultContentForType } from './content-defaults';

/** 空文档工厂（新建画布）。 */
export function createEmptyDoc(title = '未命名画布'): KBNoteDoc {
  const now = Date.now();
  return {
    format: DOC_FORMAT,
    version: CURRENT_DOC_VERSION,
    id: nanoid(8),
    title,
    board: { createdAt: now, updatedAt: now },
    nodes: [],
    edges: [],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: {
      size: 'A4',
      orientation: 'portrait',
      marginMm: 15,
      mode: 'fit',
      showPageBreak: true,
      colorMode: 'color',
      header: false,
      footer: false,
      showPageNumbers: false,
      pageBreaks: [],
    },
    assetRefs: [],
  };
}

function makeBlock(type: BlockType, x: number, y: number, patch: Partial<BlockNode> = {}): BlockNode {
  const size = DEFAULT_NODE_SIZE[type] ?? DEFAULT_NODE_SIZE.text!;
  return {
    id: nanoid(8),
    type,
    x,
    y,
    width: size.width,
    height: size.height,
    content: defaultContentForType(type),
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
    ...patch,
  };
}

/** DFS：edge 图上从 source 沿 parent→child 能否到达 target（含新边检测）。 */
function pathFromTo(edges: Edge[], from: string, to: string): Edge[] | null {
  const adj = new Map<string, { edge: Edge; child: string }[]>();
  for (const e of edges) {
    const arr = adj.get(e.source) ?? [];
    arr.push({ edge: e, child: e.target });
    adj.set(e.source, arr);
  }
  const stack: { node: string; path: Edge[] }[] = [{ node: from, path: [] }];
  const seen = new Set<string>([from]);
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.node === to) return cur.path;
    for (const next of adj.get(cur.node) ?? []) {
      if (seen.has(next.child)) continue;
      seen.add(next.child);
      stack.push({ node: next.child, path: [...cur.path, next.edge] });
    }
  }
  return null;
}

interface MockStore extends EditorSnapshot {
  _undo: KBNoteDoc[];
  _redo: KBNoteDoc[];
  _clipboard: BlockNode[];

  // internal
  _commit(next: KBNoteDoc): void;
  _setDoc(next: KBNoteDoc): void;
}

/**
 * createMockEditorApi —— 内存版 EditorApi（zustand 实现），
 * 供组件在真实 store（Wave1-C）就绪前完整可跑：基本增删改连 / 选择 / 撤销 /
 * 冲突挂起 / 假预览布局。Wave2 会把真实 store 适配成同一接口。
 */
export function createMockEditorApi(initialDoc: KBNoteDoc = createEmptyDoc()): EditorApi {
  const useStore = create<MockStore>((set, get) => ({
    doc: initialDoc,
    selection: new Set(),
    editingNodeId: null,
    mode: 'select',
    viewport: initialDoc.viewport,
    layoutPreview: null,
    pendingConflicts: null,
    searchHighlight: new Set(),
    saveState: 'saved',
    prefs: { gridSnap: false },
    lastFocus: null,

    _undo: [],
    _redo: [],
    _clipboard: [],

    _commit(next) {
      const cur = get().doc;
      set({
        _undo: [...get()._undo, cur],
        _redo: [],
        doc: { ...next, board: { ...next.board, updatedAt: Date.now() } },
        saveState: 'saved',
      });
    },
    _setDoc(next) {
      set({ doc: next, saveState: 'saved' });
    },
  }));

  const get = (): MockStore => useStore.getState();

  // useSyncExternalStore 要求 getSnapshot 缓存（同一状态返回同一引用），
  // 否则会无限重渲染。zustand 每次 set 后失效缓存（原始 store 订阅，
  // 即使没有 React 订阅者也失效，保证测试中 getState() 读到最新值）。
  let cached: EditorSnapshot | null = null;
  useStore.subscribe(() => {
    cached = null;
  });

  const api: EditorApi = {
    getState: () => {
      if (cached) return cached;
      const s = useStore.getState();
      cached = {
        doc: s.doc,
        selection: s.selection,
        editingNodeId: s.editingNodeId,
        mode: s.mode,
        viewport: s.viewport,
        layoutPreview: s.layoutPreview,
        pendingConflicts: s.pendingConflicts,
        searchHighlight: s.searchHighlight,
        saveState: s.saveState,
        prefs: s.prefs,
        lastFocus: s.lastFocus,
      };
      return cached;
    },
    subscribe: (fn) => useStore.subscribe(fn),

    addNode(type, x, y) {
      const block = makeBlock(type, x, y);
      get()._commit({ ...get().doc, nodes: [...get().doc.nodes, block] });
      useStore.setState({ selection: new Set([block.id]), editingNodeId: null });
      return block.id;
    },

    addNodes(nodes) {
      get()._commit({ ...get().doc, nodes: [...get().doc.nodes, ...nodes] });
    },

    addImageBlock(dataUrl, x, y) {
      const block = makeBlock('image', x, y, { image: { src: dataUrl, alt: '' } });
      get()._commit({ ...get().doc, nodes: [...get().doc.nodes, block] });
      useStore.setState({ selection: new Set([block.id]) });
      return block.id;
    },

    deleteNodes(ids) {
      const set = new Set(ids);
      const doc = get().doc;
      get()._commit({
        ...doc,
        nodes: doc.nodes.filter((n) => !set.has(n.id)),
        edges: doc.edges.filter((e) => !set.has(e.source) && !set.has(e.target)),
      });
      const sel = new Set([...get().selection].filter((id) => !set.has(id)));
      useStore.setState({ selection: sel, editingNodeId: null });
    },

    updateContent(id, data) {
      // 合并写（mock 不做防抖；真实 store 用 coalesceKey 合并）。
      const doc = get().doc;
      get()._setDoc({
        ...doc,
        nodes: doc.nodes.map((n) => (n.id === id ? { ...n, content: { format: 'tiptap-json' as const, data } } : n)),
      });
    },

    setBlockType(id, type) {
      const doc = get().doc;
      const size = DEFAULT_NODE_SIZE[type] ?? DEFAULT_NODE_SIZE.text!;
      get()._commit({
        ...doc,
        nodes: doc.nodes.map((n) =>
          n.id === id
            ? { ...n, type, content: defaultContentForType(type), width: n.type === 'image' || n.type === 'group' ? n.width : size.width }
            : n,
        ),
      });
    },

    moveNode(id, x, y) {
      const doc = get().doc;
      get()._setDoc({ ...doc, nodes: doc.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) });
    },

    resizeNode(id, width, height) {
      const doc = get().doc;
      get()._commit({
        ...doc,
        nodes: doc.nodes.map((n) => (n.id === id ? { ...n, width: Math.max(160, width), height } : n)),
      });
    },

    setMeasuredSizes(sizes) {
      const doc = get().doc;
      let changed = false;
      const nodes = doc.nodes.map((n) => {
        const patch = sizes[n.id];
        if (!patch) return n;
        changed = true;
        return {
          ...n,
          width: patch.width !== undefined ? Math.max(160, patch.width) : n.width,
          height: patch.height !== undefined ? Math.max(24, patch.height) : n.height,
        };
      });
      if (changed) get()._setDoc({ ...doc, nodes });
    },

    addEdge(source, target, opts) {
      if (source === target) return; // 自环：画布侧已拦截，这里兜底
      const doc = get().doc;
      const edge: Edge = {
        id: nanoid(8),
        source,
        target,
        sourceHandle: opts?.sourceHandle ?? 'right',
        targetHandle: opts?.targetHandle ?? 'left',
        label: opts?.label ?? '',
        directed: true,
        style: { color: DEFAULT_EDGE_COLOR.hex },
      };

      // 成环检测：已存在 target →…→ source 的路径时，再加 source→target 成环。
      const cyclePath = pathFromTo(doc.edges, target, source);
      // 多父检测：target 的入边（含新边）> 1。
      const incoming = doc.edges.filter((e) => e.target === target);
      const isMultiParent = incoming.length >= 1;

      const nextEdges = [...doc.edges, edge];
      get()._setDoc({ ...doc, edges: nextEdges });

      if (cyclePath || isMultiParent) {
        const provisionalEdgeIds = [edge.id];
        const multiParents: PendingConflicts['multiParents'] = [];
        const cycles: PendingConflicts['cycles'] = [];
        if (isMultiParent) {
          multiParents.push({
            nodeId: target,
            parentEdgeIds: [...incoming.map((e) => e.id), edge.id],
            parentIds: [...incoming.map((e) => e.source), source],
          });
        }
        if (cyclePath) {
          cycles.push({
            nodeIds: [...new Set([...cyclePath.map((e) => e.source), ...cyclePath.map((e) => e.target), target])],
            edgeIds: [...cyclePath.map((e) => e.id), edge.id],
          });
        }
        useStore.setState({ pendingConflicts: { provisionalEdgeIds, multiParents, cycles } });
      }
    },

    deleteEdge(id) {
      const doc = get().doc;
      get()._commit({ ...doc, edges: doc.edges.filter((e) => e.id !== id) });
    },

    setEdgeColor(id, color) {
      const doc = get().doc;
      get()._setDoc({
        ...doc,
        edges: doc.edges.map((e) => (e.id === id ? { ...e, style: { color } } : e)),
      });
    },

    setEdgeLabel(id, label) {
      const doc = get().doc;
      get()._setDoc({ ...doc, edges: doc.edges.map((e) => (e.id === id ? { ...e, label } : e)) });
    },

    tabAddChild() {
      const sel = [...get().selection];
      if (sel.length !== 1) return;
      const parent = get().doc.nodes.find((n) => n.id === sel[0]);
      if (!parent) return;
      const child = makeBlock('text', parent.x + parent.width + 120, parent.y + 40);
      const edge: Edge = {
        id: nanoid(8),
        source: parent.id,
        target: child.id,
        sourceHandle: 'right',
        targetHandle: 'left',
        label: '',
        directed: true,
        style: { color: DEFAULT_EDGE_COLOR.hex },
      };
      const doc = get().doc;
      get()._commit({ ...doc, nodes: [...doc.nodes, child], edges: [...doc.edges, edge] });
      useStore.setState({ selection: new Set([child.id]), editingNodeId: child.id });
    },

    enterAddSibling() {
      const sel = [...get().selection];
      if (sel.length !== 1) return;
      const doc = get().doc;
      const cur = doc.nodes.find((n) => n.id === sel[0]);
      if (!cur) return;
      const parentEdge = doc.edges.find((e) => e.target === cur.id);
      const sibling = makeBlock('text', cur.x, cur.y + cur.height + 40);
      let edges = doc.edges;
      if (parentEdge) {
        edges = [
          ...edges,
          {
            id: nanoid(8),
            source: parentEdge.source,
            target: sibling.id,
            sourceHandle: 'right' as const,
            targetHandle: 'left' as const,
            label: '',
            directed: true as const,
            style: { color: DEFAULT_EDGE_COLOR.hex },
          },
        ];
      }
      get()._commit({ ...doc, nodes: [...doc.nodes, sibling], edges });
      useStore.setState({ selection: new Set([sibling.id]), editingNodeId: sibling.id });
    },

    shiftTabDemote() {
      const sel = [...get().selection];
      if (sel.length !== 1) return;
      const doc = get().doc;
      const edge = doc.edges.find((e) => e.target === sel[0]);
      if (!edge) return;
      const grandEdge = doc.edges.find((e) => e.target === edge.source);
      if (!grandEdge) return;
      // 断开当前父边，挂到祖父。
      const nextEdges = doc.edges
        .filter((e) => e.id !== edge.id)
        .concat({
          id: nanoid(8),
          source: grandEdge.source,
          target: edge.target,
          sourceHandle: 'right' as const,
          targetHandle: 'left' as const,
          label: '',
          directed: true as const,
          style: { color: DEFAULT_EDGE_COLOR.hex },
        });
      get()._commit({ ...doc, edges: nextEdges });
    },

    togglePin(id) {
      const doc = get().doc;
      get()._commit({ ...doc, nodes: doc.nodes.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n)) });
    },

    toggleCollapse(id) {
      const doc = get().doc;
      get()._commit({ ...doc, nodes: doc.nodes.map((n) => (n.id === id ? { ...n, collapsed: !n.collapsed } : n)) });
    },

    toggleTodo(id) {
      const doc = get().doc;
      get()._commit({
        ...doc,
        nodes: doc.nodes.map((n) => (n.id === id ? { ...n, todo: { checked: !n.todo?.checked } } : n)),
      });
    },

    setBlockStyle(id, patch) {
      const doc = get().doc;
      get()._commit({
        ...doc,
        nodes: doc.nodes.map((n) => (n.id === id ? { ...n, style: { ...n.style, ...patch } } : n)),
      });
    },

    setSelection(ids) {
      useStore.setState({ selection: new Set(ids) });
    },

    setMode(mode: InteractionMode) {
      useStore.setState({ mode });
    },

    setEditingNode(id) {
      useStore.setState({ editingNodeId: id });
    },

    setViewport(vp: Viewport) {
      useStore.setState({ viewport: vp });
    },

    copy() {
      const doc = get().doc;
      const sel = new Set(get().selection);
      const nodes = doc.nodes.filter((n) => sel.has(n.id)).map((n) => ({ ...n, content: { ...n.content } }));
      useStore.setState({ _clipboard: nodes });
    },

    cut() {
      api.copy();
      api.deleteNodes([...get().selection]);
    },

    paste() {
      const clip = get()._clipboard;
      if (!clip.length) return;
      const doc = get().doc;
      const idMap = new Map<string, string>();
      const nodes = clip.map((n) => {
        const nn = { ...n, id: nanoid(8), x: n.x + 60, y: n.y + 60 };
        idMap.set(n.id, nn.id);
        return nn;
      });
      const edges = doc.edges
        .filter((e) => idMap.has(e.source) && idMap.has(e.target))
        .map((e) => ({ ...e, id: nanoid(8), source: idMap.get(e.source)!, target: idMap.get(e.target)! }));
      get()._commit({ ...doc, nodes: [...doc.nodes, ...nodes], edges: [...doc.edges, ...edges] });
      useStore.setState({ selection: new Set(nodes.map((n) => n.id)) });
    },

    duplicate() {
      api.copy();
      api.paste();
    },

    undo() {
      const undo = get()._undo;
      if (!undo.length) return;
      const cur = get().doc;
      const prev = undo[undo.length - 1]!;
      useStore.setState({
        _undo: undo.slice(0, -1),
        _redo: [...get()._redo, cur],
        doc: prev,
        layoutPreview: null,
      });
    },

    redo() {
      const redo = get()._redo;
      if (!redo.length) return;
      const cur = get().doc;
      const next = redo[redo.length - 1]!;
      useStore.setState({
        _redo: redo.slice(0, -1),
        _undo: [...get()._undo, cur],
        doc: next,
        layoutPreview: null,
      });
    },

    previewLayout() {
      // mock 简易 mindmap-right：按父子边 BFS 分层。
      const doc = get().doc;
      const childrenOf = new Map<string, string[]>();
      const parentOf = new Map<string, string>();
      for (const e of doc.edges) {
        childrenOf.set(e.source, [...(childrenOf.get(e.source) ?? []), e.target]);
        parentOf.set(e.target, e.source);
      }
      const roots = doc.nodes.filter((n) => !parentOf.has(n.id));
      const skip = new Set<string>();
      const ghosts: Record<string, LayoutGhost> = {};
      let row = 0;
      const walk = (id: string, depth: number) => {
        if (skip.has(id)) return;
        skip.add(id);
        const node = doc.nodes.find((n) => n.id === id);
        if (!node) return;
        if (!node.pinned) {
          ghosts[id] = { x: depth * 260, y: row * 100, width: node.width, height: node.height };
        }
        row += 1;
        for (const c of childrenOf.get(id) ?? []) {
          if (node.collapsed) continue;
          walk(c, depth + 1);
        }
      };
      for (const r of roots) walk(r.id, 0);
      useStore.setState({ layoutPreview: ghosts });
    },

    confirmLayout() {
      const doc = get().doc;
      const ghost = get().layoutPreview;
      if (!ghost) return;
      const nodes = doc.nodes.map((n) => {
        const g = ghost[n.id];
        return g ? { ...n, x: g.x, y: g.y } : n;
      });
      get()._commit({ ...doc, nodes });
      useStore.setState({ layoutPreview: null });
    },

    cancelLayout() {
      useStore.setState({ layoutPreview: null });
    },

    resolveConflicts(r: ConflictResolutionInput) {
      const doc = get().doc;
      let edges = doc.edges;
      // 多父：每个冲突节点只保留选定主父边。
      for (const [nodeId, keepEdgeId] of Object.entries(r.choosePrimaryParent)) {
        const incoming = edges.filter((e) => e.target === nodeId);
        edges = edges.filter((e) => e.target !== nodeId || e.id === keepEdgeId);
        void incoming;
      }
      // 断环边。
      const breakSet = new Set(r.breakEdgeIds);
      edges = edges.filter((e) => !breakSet.has(e.id));
      get()._commit({ ...doc, edges });
      useStore.setState({ pendingConflicts: null });
    },

    cancelConflicts() {
      const pending = get().pendingConflicts;
      const doc = get().doc;
      if (pending) {
        const drop = new Set(pending.provisionalEdgeIds);
        get()._commit({ ...doc, edges: doc.edges.filter((e) => !drop.has(e.id)) });
      }
      useStore.setState({ pendingConflicts: null });
    },

    setGridSnap(on) {
      useStore.setState({ prefs: { ...get().prefs, gridSnap: on } });
    },

    openSearch() {},
    openExport() {},
    save() {
      useStore.setState({ saveState: 'saved' });
    },
  };

  return api;
}
