import type { BlockNode, BlockType, Edge, KBNoteDoc } from '@drawpaper/core';

/**
 * e2e 夹具构建器：纯数据，经 window.__drawpaper__.loadFixture 灌进 store。
 *
 * - buildStandardFixture()：30 块、≥3 块型、≥4 层父子树、横向一页放不下；
 *   另含 1 个与主体无边连接的孤块、1 个折叠子树（导出验证剔除）。
 * - buildPerfFixture(n)：程序化大树（性能采样用）。
 */

let counter = 0;
function nid(prefix = 'n'): string {
  counter += 1;
  return `${prefix}_${counter}_${Date.now().toString(36)}`;
}

function tipDoc(text: string): { format: 'tiptap-json'; data: unknown } {
  return {
    format: 'tiptap-json',
    data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  };
}

function makeNode(
  id: string,
  type: BlockType,
  x: number,
  y: number,
  text: string,
  over?: Partial<BlockNode>,
): BlockNode {
  return {
    id,
    type,
    x,
    y,
    width: 240,
    height: 72,
    content: tipDoc(text),
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
    ...over,
  };
}

function makeEdge(source: string, target: string): Edge {
  return {
    id: `e_${source}_${target}`,
    source,
    target,
    sourceHandle: 'right',
    targetHandle: 'left',
    label: '',
    directed: true,
    style: { color: '#60A5FA' },
  };
}

function baseDoc(title: string): KBNoteDoc {
  const now = Date.now();
  return {
    format: 'knowledge-block-notes',
    version: 3,
    id: nid('doc'),
    title,
    board: { createdAt: now, updatedAt: now },
    nodes: [],
    edges: [],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: {
      size: 'A4',
      orientation: 'landscape',
      marginMm: 15,
      mode: 'tiles',
      showPageBreak: true,
      colorMode: 'color',
      header: true,
      footer: true,
      showPageNumbers: true,
      edgeLabels: true,
      pageBreaks: [],
    },
    assetRefs: [],
    links: [],
    sync: { vv: {} },
  };
}

/**
 * 手工 mindmap-right 布局：深度→x，DFS 叶子槽位→y。
 * 返回 { nodes, edges, collapsedId, orphanId, collapsedDescendants }。
 */
export function buildStandardFixture(title = '验收样例') {
  counter = 0;
  const doc = baseDoc(title);
  const types: BlockType[] = ['heading', 'text', 'todo', 'note', 'bullet'];

  let ySlot = 0;
  const RANK_X = 340;
  const SLOT_Y = 96;

  const addSubtree = (
    parentId: string | null,
    depth: number,
    maxDepth: number,
    out: { nodes: BlockNode[]; edges: Edge[]; childrenOf: Map<string, string[]> },
  ): string => {
    const id = nid('n');
    const type = types[(counter + depth) % types.length]!;
    // x 由深度决定；y 由 DFS 叶子槽决定（占位，叶子阶段赋真实 y）。
    out.nodes.push(makeNode(id, type, depth * RANK_X, 0, `${type}#${counter}`));
    if (parentId) {
      out.edges.push(makeEdge(parentId, id));
      const arr = out.childrenOf.get(parentId) ?? [];
      arr.push(id);
      out.childrenOf.set(parentId, arr);
    }
    if (depth < maxDepth) {
      const kids = depth === 0 ? 3 : 2;
      for (let k = 0; k < kids; k++) addSubtree(id, depth + 1, maxDepth, out);
    }
    return id;
  };

  const out = { nodes: [] as BlockNode[], edges: [] as Edge[], childrenOf: new Map<string, string[]>() };
  const rootId = addSubtree(null, 0, 4, out);

  // DFS 赋 y 槽（叶子顺序堆叠）。
  const assignY = (id: string): void => {
    const kids = out.childrenOf.get(id) ?? [];
    if (kids.length === 0) {
      const n = out.nodes.find((x) => x.id === id)!;
      n.y = ySlot * SLOT_Y;
      ySlot += 1;
      return;
    }
    for (const c of kids) assignY(c);
    // 父节点 y = 子树 y 中点。
    const childYs = kids.map((k) => out.nodes.find((x) => x.id === k)!.y);
    const n = out.nodes.find((x) => x.id === id)!;
    n.y = (Math.min(...childYs) + Math.max(...childYs)) / 2 - n.height / 2;
  };
  assignY(rootId);

  // 折叠一个深层节点（非根、有后代）。
  let collapsedId = '';
  for (const n of out.nodes) {
    if (n.id === rootId) continue;
    const kids = out.childrenOf.get(n.id) ?? [];
    if (kids.length > 0) {
      collapsedId = n.id;
      n.collapsed = true;
      break;
    }
  }
  const collapsedDescendants: string[] = [];
  const stack = [...(out.childrenOf.get(collapsedId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    collapsedDescendants.push(id);
    stack.push(...(out.childrenOf.get(id) ?? []));
  }

  // 孤块：与主树无连接（位置放在主树右侧附近，便于画布查看；导出时它自成一分量）。
  const orphanId = nid('orphan');
  out.nodes.push(makeNode(orphanId, 'note', 2600, 300, '孤块-无连接'));

  doc.nodes = out.nodes;
  doc.edges = out.edges;

  return { doc, rootId, collapsedId, orphanId, collapsedDescendants };
}

/** 性能夹具：一棵 n 节点的大树（mindmap-right 手工布局）。 */
export function buildPerfFixture(totalNodes: number, title = '性能样例'): KBNoteDoc {
  counter = 100000;
  const doc = baseDoc(title);
  const nodes: BlockNode[] = [];
  const edges: Edge[] = [];
  const childrenOf = new Map<string, string[]>();
  let ySlot = 0;
  const RANK_X = 340;
  const SLOT_Y = 96;

  const rootId = nid('root');
  nodes.push(makeNode(rootId, 'heading', 0, 0, 'root'));

  let created = 1;
  const addSubtree = (parentId: string, depth: number) => {
    if (created >= totalNodes) return;
    const id = nid('n');
    created += 1;
    nodes.push(makeNode(id, 'text', depth * RANK_X, 0, `block ${id}`));
    edges.push(makeEdge(parentId, id));
    const arr = childrenOf.get(parentId) ?? [];
    arr.push(id);
    childrenOf.set(parentId, arr);
    // 每个节点 2 子，直到凑够。
    for (let k = 0; k < 2 && created < totalNodes; k++) addSubtree(id, depth + 1);
  };
  // root 3 子。
  for (let k = 0; k < 3; k++) addSubtree(rootId, 1);

  const assignY = (id: string): void => {
    const kids = childrenOf.get(id) ?? [];
    if (kids.length === 0) {
      const n = nodes.find((x) => x.id === id)!;
      n.y = ySlot * SLOT_Y;
      ySlot += 1;
      return;
    }
    for (const c of kids) assignY(c);
    const childYs = kids.map((k) => nodes.find((x) => x.id === k)!.y);
    const n = nodes.find((x) => x.id === id)!;
    n.y = (Math.min(...childYs) + Math.max(...childYs)) / 2 - n.height / 2;
  };
  assignY(rootId);

  doc.nodes = nodes;
  doc.edges = edges;
  return doc;
}

/**
 * 性能夹具（大 n，迭代版）：buildPerfFixture 的递归版在 n=10000 时
 * 因左 spine 递归过深爆栈（RangeError）。本版用队列 BFS 建树 + 迭代后序
 * 计算 Y，形状与 mindmap-right 一致（深度→x，叶子槽位→y），但不递归。
 * 用于 10000 块基准（perf-10k.bench.spec.ts）。
 */
export function buildPerfFixtureWide(totalNodes: number, title = '性能样例'): KBNoteDoc {
  counter = 100000;
  const doc = baseDoc(title);
  const nodes: BlockNode[] = [];
  const edges: Edge[] = [];
  const childrenOf = new Map<string, string[]>();
  const byId = new Map<string, BlockNode>();
  const SLOT_Y = 96;

  const rootId = nid('root');
  const root = makeNode(rootId, 'heading', 0, 0, 'root');
  nodes.push(root);
  byId.set(rootId, root);

  // BFS 建树：根 3 子，其余每节点 2 子，直到凑够 totalNodes。
  const queue: string[] = [rootId];
  let created = 1;
  while (created < totalNodes && queue.length > 0) {
    const parentId = queue.shift()!;
    const childCount = parentId === rootId ? 3 : 2;
    for (let k = 0; k < childCount && created < totalNodes; k++) {
      const id = nid('n');
      created += 1;
      const parent = byId.get(parentId)!;
      const node = makeNode(id, 'text', parent.x + 340, 0, `block ${id}`);
      nodes.push(node);
      byId.set(id, node);
      edges.push(makeEdge(parentId, id));
      const arr = childrenOf.get(parentId) ?? [];
      arr.push(id);
      childrenOf.set(parentId, arr);
      queue.push(id);
    }
  }

  // 迭代后序计算 Y：叶子按顺序占槽，内部节点取子节点 y 中点。
  let ySlot = 0;
  const yById = new Map<string, number>();
  const stack: Array<{ id: string; visited: boolean }> = [{ id: rootId, visited: false }];
  while (stack.length > 0) {
    const { id, visited } = stack.pop()!;
    const kids = childrenOf.get(id) ?? [];
    if (!visited) {
      stack.push({ id, visited: true });
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i]!, visited: false });
    } else {
      if (kids.length === 0) {
        yById.set(id, ySlot * SLOT_Y);
        ySlot += 1;
      } else {
        const childYs = kids.map((k) => yById.get(k)!);
        const node = byId.get(id)!;
        yById.set(id, (Math.min(...childYs) + Math.max(...childYs)) / 2 - node.height / 2);
      }
    }
  }
  for (const n of nodes) n.y = yById.get(n.id)!;

  doc.nodes = nodes;
  doc.edges = edges;
  return doc;
}
