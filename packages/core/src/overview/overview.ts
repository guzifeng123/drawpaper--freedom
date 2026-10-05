import type { BlockType, DocRefLink, Edge } from '../model/index.js';

/**
 * overview 模块：跨文档全局知识图谱总览（纯函数、零 DOM、确定性）。
 *
 * 把多份 KBNoteDoc 聚合成一张「全局图」：
 *  - 文档内父子边 → `parent` 边（块到块）；
 *  - DocRefLink（[[双向链接]]）→ `docref` 边（块到块，可跨文档）。
 * 节点 id 全限定：块节点 `b:<docId>::<nodeId>`，文档簇 `d:<docId>`。
 *
 * 视图派生：文档级折叠/展开 → computeView；大图采样 → maybeCollapseForScale；
 * 轻量布局 → layoutOverviewView（自研放射 + 网格，禁 d3-force/dagre/elkjs）；
 * 搜索过滤 → searchOverview。
 */

/** 单份文档送入聚合的节点摘要（label 由 web 从 Tiptap 内容抽首行，core 不解析富文本）。 */
export interface OverviewDocNodeInput {
  id: string;
  type: BlockType;
  /** 纯文本标签（首行/标题），用于搜索与展示。 */
  label: string;
}

/** 单份文档送入聚合的输入。 */
export interface OverviewDocInput {
  id: string;
  title: string;
  nodes: OverviewDocNodeInput[];
  /** 文档内父子边（source=父块, target=子块）。 */
  edges: Edge[];
  /** 文档内 / 跨文档双链。 */
  links: DocRefLink[];
}

/** 总览图节点。 */
export interface OverviewNode {
  /** 全限定 id：块 `b:<docId>::<nodeId>`，文档簇 `d:<docId>`。 */
  id: string;
  docId: string;
  /** 簇节点为 'doc'，块节点为 'block'。 */
  kind: 'doc' | 'block';
  title: string;
  blockType?: BlockType;
}

/** 总览图边。 */
export interface OverviewEdge {
  id: string;
  source: string;
  target: string;
  /** parent=文档内父子；docref=[[双向链接]]（可跨文档）。 */
  type: 'parent' | 'docref';
}

/** 文档分组元信息。 */
export interface OverviewDocMeta {
  docId: string;
  title: string;
  nodeCount: number;
}

/** 聚合后的规范模型（全量数据，不含可见性）。 */
export interface OverviewModel {
  docs: OverviewDocMeta[];
  blockNodes: OverviewNode[];
  parentEdges: OverviewEdge[];
  docrefEdges: OverviewEdge[];
}

/** 派生视图（可见节点/边，供 ReactFlow 渲染）。 */
export interface OverviewView {
  nodes: OverviewNode[];
  edges: OverviewEdge[];
  /** 当前折叠的文档 id 集合。 */
  collapsedDocIds: string[];
}

/** 块节点全限定 id。 */
export function blockFqid(docId: string, nodeId: string): string {
  return `b:${docId}::${nodeId}`;
}

/** 文档簇节点 id。 */
export function docClusterId(docId: string): string {
  return `d:${docId}`;
}

/**
 * 聚合多份文档为规范模型。确定性：docs/nodes/edges/links 按字典序归一并排序输出。
 * - 文档内 edges → parent 边；
 * - links → docref 边（source/target 用全限定 id，端点缺失时丢弃该边）。
 */
export function aggregateOverview(docs: OverviewDocInput[]): OverviewModel {
  const blockNodes: OverviewNode[] = [];
  const parentEdges: OverviewEdge[] = [];
  const docrefEdges: OverviewEdge[] = [];
  const docMetas: OverviewDocMeta[] = [];

  const knownBlock = new Set<string>();
  const sortedDocs = [...docs].sort((a, b) => a.id.localeCompare(b.id));

  // Pass 1：登记全部块（跨文档边端点可能在另一文档，需先全量登记）。
  for (const doc of sortedDocs) {
    docMetas.push({ docId: doc.id, title: doc.title, nodeCount: doc.nodes.length });
    for (const n of [...doc.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
      knownBlock.add(blockFqid(doc.id, n.id));
    }
  }

  // Pass 2：发射节点与边。
  for (const doc of sortedDocs) {
    for (const n of [...doc.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
      blockNodes.push({ id: blockFqid(doc.id, n.id), docId: doc.id, kind: 'block', title: n.label, blockType: n.type });
    }
    for (const e of [...doc.edges].sort((a, b) => a.id.localeCompare(b.id))) {
      const s = blockFqid(doc.id, e.source);
      const t = blockFqid(doc.id, e.target);
      if (!knownBlock.has(s) || !knownBlock.has(t)) continue;
      parentEdges.push({ id: `pe:${e.id}`, source: s, target: t, type: 'parent' });
    }
    for (const link of [...doc.links].sort((a, b) => a.id.localeCompare(b.id))) {
      const s = blockFqid(link.sourceDocId, link.sourceNodeId);
      const t = blockFqid(link.targetDocId, link.targetNodeId);
      if (!knownBlock.has(s) || !knownBlock.has(t)) continue;
      if (s === t) continue;
      docrefEdges.push({ id: `dr:${link.id}`, source: s, target: t, type: 'docref' });
    }
  }

  // 去重（同一边可能因多文档重复出现）并排序，保证确定性。
  const uniq = <T extends { id: string }>(arr: T[]): T[] => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const x of arr) {
      if (seen.has(x.id)) continue;
      seen.add(x.id);
      out.push(x);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  };

  return {
    docs: docMetas.sort((a, b) => a.docId.localeCompare(b.docId)),
    blockNodes: uniq(blockNodes),
    parentEdges: uniq(parentEdges),
    docrefEdges: uniq(docrefEdges),
  };
}

/**
 * 派生可见视图：按 collapsedDocIds 折叠文档。
 * - 折叠文档：发射一个簇节点 `d:<docId>`，其内部块/parent 边隐藏；
 *   docref 边端点若落在折叠文档 → 重映射到簇节点。
 * - 展开文档：发射全部块节点 + 内部 parent 边；docref 边连到真实块端点。
 */
export function computeView(
  model: OverviewModel,
  collapsedDocIds: ReadonlySet<string>,
): OverviewView {
  const nodes: OverviewNode[] = [];
  const edges: OverviewEdge[] = [];

  const blockByDoc = new Map<string, OverviewNode[]>();
  for (const n of model.blockNodes) {
    const arr = blockByDoc.get(n.docId) ?? [];
    arr.push(n);
    blockByDoc.set(n.docId, arr);
  }

  for (const meta of model.docs) {
    if (collapsedDocIds.has(meta.docId)) {
      nodes.push({ id: docClusterId(meta.docId), docId: meta.docId, kind: 'doc', title: meta.title });
    } else {
      const blocks = (blockByDoc.get(meta.docId) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
      nodes.push(...blocks);
    }
  }

  // parent 边：仅两端都在展开文档（且端点块可见）。
  const visibleBlock = new Set(nodes.filter((n) => n.kind === 'block').map((n) => n.id));
  for (const e of model.parentEdges) {
    if (visibleBlock.has(e.source) && visibleBlock.has(e.target)) edges.push(e);
  }

  // docref 边：端点按折叠状态重映射。
  const remap = (fqid: string): string => {
    const node = model.blockNodes.find((n) => n.id === fqid);
    if (!node) return fqid;
    return collapsedDocIds.has(node.docId) ? docClusterId(node.docId) : fqid;
  };
  for (const e of model.docrefEdges) {
    const s = remap(e.source);
    const t = remap(e.target);
    if (s === t) continue; // 两端都折进同一簇 → 内部边，隐藏
    edges.push({ id: e.id, source: s, target: t, type: 'docref' });
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));

  return {
    nodes,
    edges,
    collapsedDocIds: [...collapsedDocIds].sort(),
  };
}

/** 全部折叠（每文档聚成一簇）。 */
export function collapseToDocs(model: OverviewModel): OverviewView {
  return computeView(model, new Set(model.docs.map((d) => d.docId)));
}

/** 展开某文档：返回去掉 docId 的新折叠集合（纯函数，不改入参）。 */
export function expandDoc(collapsedDocIds: ReadonlySet<string>, docId: string): Set<string> {
  const next = new Set(collapsedDocIds);
  next.delete(docId);
  return next;
}

/** 折叠某文档。 */
export function collapseDoc(collapsedDocIds: ReadonlySet<string>, docId: string): Set<string> {
  const next = new Set(collapsedDocIds);
  next.add(docId);
  return next;
}

/** 大图采样阈值：可见节点超过此数时建议全折叠到文档簇。 */
export const OVERVIEW_NODE_SOFT_LIMIT = 600;

/**
 * 大图采样：若当前视图可见节点 > softLimit，自动折叠到文档簇视图（确定性）。
 * 返回是否触发了折叠。调用方据返回值提示用户「已按文档聚合」。
 */
export function maybeCollapseForScale(
  model: OverviewModel,
  collapsedDocIds: ReadonlySet<string>,
  softLimit: number = OVERVIEW_NODE_SOFT_LIMIT,
): { view: OverviewView; collapsed: boolean } {
  const current = computeView(model, collapsedDocIds);
  if (current.nodes.length <= softLimit) return { view: current, collapsed: false };
  const collapsed = collapseToDocs(model);
  return { view: collapsed, collapsed: true };
}

/** 布局常量。 */
export const OVERVIEW_LAYOUT = {
  clusterRadius: 420,
  clusterCenterX: 0,
  clusterCenterY: 0,
  blockCellW: 300,
  blockCellH: 110,
  blockGridCols: 3,
} as const;

/**
 * 轻量布局（纯函数、确定性、无重叠）：
 *  - 文档簇：按字典序在圆周上均分角度；
 *  - 展开文档的块：以簇位置为中心，按网格行列铺开（向右下）。
 * 不使用 d3-force/dagre/elkjs；簇间用确定性放射。
 */
export function layoutOverviewView(view: OverviewView): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  const { clusterRadius, clusterCenterX, clusterCenterY, blockCellW, blockCellH, blockGridCols } =
    OVERVIEW_LAYOUT;

  // 按 docId 归集视图中出现的节点（簇节点或展开块）。
  const docsInView = new Map<string, { cluster: OverviewNode | null; blocks: OverviewNode[] }>();
  const ensure = (docId: string) => {
    if (!docsInView.has(docId)) docsInView.set(docId, { cluster: null, blocks: [] });
    return docsInView.get(docId)!;
  };
  for (const n of view.nodes) {
    const bucket = ensure(n.docId);
    if (n.kind === 'doc') bucket.cluster = n;
    else bucket.blocks.push(n);
  }

  const docIds = [...docsInView.keys()].sort();
  const n = docIds.length;

  docIds.forEach((docId, i) => {
    const angle = n === 1 ? -Math.PI / 2 : -Math.PI / 2 + (i / n) * Math.PI * 2;
    const cx = clusterCenterX + clusterRadius * Math.cos(angle);
    const cy = clusterCenterY + clusterRadius * Math.sin(angle);
    const bucket = docsInView.get(docId)!;

    if (bucket.cluster) {
      out[bucket.cluster.id] = { x: cx, y: cy };
    }
    bucket.blocks.sort((a, b) => a.id.localeCompare(b.id)).forEach((b, j) => {
      const col = j % blockGridCols;
      const row = Math.floor(j / blockGridCols);
      out[b.id] = { x: cx + col * blockCellW, y: cy + row * blockCellH };
    });
  });

  return out;
}

/** 搜索结果。 */
export interface OverviewSearchResult {
  /** 命中的块全限定 id。 */
  matchedBlockIds: string[];
  /** 推荐展开的文档 id（含命中块或标题命中）。 */
  recommendedDocIds: string[];
}

/**
 * 搜索过滤：按标题/标签小写子串匹配。确定性（字典序）。
 * 命中块 → matchedBlockIds；命中块所在文档或文档标题命中 → recommendedDocIds。
 */
export function searchOverview(model: OverviewModel, query: string): OverviewSearchResult {
  const q = query.trim().toLowerCase();
  if (!q) return { matchedBlockIds: [], recommendedDocIds: [] };

  const matchedBlockIds: string[] = [];
  const recommended = new Set<string>();

  for (const b of model.blockNodes) {
    if (b.title.toLowerCase().includes(q)) {
      matchedBlockIds.push(b.id);
      recommended.add(b.docId);
    }
  }
  for (const d of model.docs) {
    if (d.title.toLowerCase().includes(q)) recommended.add(d.docId);
  }

  matchedBlockIds.sort();
  return {
    matchedBlockIds,
    recommendedDocIds: [...recommended].sort(),
  };
}
