import { hierarchy, tree } from 'd3-hierarchy';
import type { BlockNode, Edge, LayoutMode } from '../model/index.js';

/**
 * layout 模块：d3-hierarchy 驱动的纯函数树布局（零 DOM、确定性输出）。
 *
 * 支持三种 P0 模式（见 model/layout.ts 的 LayoutMode）：
 *  - `mindmap-right`：思维导图横向，根在左、子树向右展开（深度轴 = x）。
 *  - `mindmap-down`：思维导图纵向，根在上、子树向下展开（深度轴 = y），
 *    纵向行距由「逐节点实测高度 + rankSpacing」驱动（每个节点占据自己的高度槽）。
 *  - `org-tree`：组织结构树，与 mindmap-down 同方向（根在上），但采用
 *    **固定行高对齐**——每一行的高度取该行内最大实测高 + nodeSpacing，
 *    同层节点顶对齐、父节点水平居中于其子树之上。
 *    （与 mindmap-down 的差异：mindmap-down 的纵向 pitch 随每个节点实测高变化，
 *     org-tree 则按行统一取最大行高，行外观更整齐、行距恒定。）
 *  - `radial`：P1 预留，未实现，调用即抛错。
 */

/** 块实测尺寸（由 web 侧 ResizeObserver 注入；布局引擎不自己测）。 */
export interface MeasuredSize {
  width: number;
  height: number;
}

/** 冲突/碰撞报告。 */
export interface CollisionReport {
  /** 发生重叠的节点 id 对（未被绕行消除的残留重叠，按字典序排序保证确定）。 */
  overlappingPairs: Array<[string, string]>;
  /** 被 pinned 阻挡、布局引擎绕行时被动过的节点 id。 */
  detouredNodes: string[];
}

/** 单个节点布局落点（BlockNode 左上角，画布世界坐标 px）。 */
export interface LayoutPosition {
  x: number;
  y: number;
}

/** 布局结果：节点 id → 落点坐标（画布世界坐标）。 */
export interface LayoutResult {
  positions: Record<string, LayoutPosition>;
  collisions: CollisionReport;
  /** 人类可读的绕行/折叠/碰撞说明（调试/预览用）。 */
  notes: string[];
}

/**
 * 布局输入。
 */
export interface LayoutInput {
  /**
   * 参与布局的节点集合（「仅整理选中分支」时只传该子树）。
   * BlockNode.x/.y 同时作为 pinned 节点的锚点坐标（pinned 时不参与 d3 布局）。
   */
  nodes: BlockNode[];
  /** 父子边（source=父，target=子）。 */
  edges: Edge[];
  /** 指定根节点 id（缺省由输入裁决：集合内无入边的节点，多个时取字典序最小）。 */
  rootId?: string;
  /** 层级（父子）间距 px。 */
  rankSpacing: number;
  /** 同级兄弟间距 px。 */
  nodeSpacing: number;
  /** 块实测尺寸（id → size）。缺失项走 DEFAULT_NODE_SIZE。 */
  measured: Record<string, MeasuredSize>;
  /** pinned 节点集合：布局不移动它们，并为其绕行。 */
  pinned?: ReadonlySet<string>;
  /** collapsedMap：id → 是否折叠；折叠子树收为一个单位，不展开内部后代。 */
  collapsed?: Readonly<Record<string, boolean>>;
}

/**
 * 缺省节点占位尺寸（实测缺失时使用）：260 × 80 px。
 */
export const DEFAULT_NODE_SIZE: MeasuredSize = { width: 260, height: 80 };

/** pinned 绕行时与被遮挡节点之间额外留出的间隙（px），取 nodeSpacing。 */
const DETOUR_GAP_FACTOR = 1;
/** pinned 绕行最大迭代轮数。 */
const DETOUR_MAX_ROUNDS = 3;

/** 内部嵌套节点（供 d3 hierarchy 消费）。 */
interface NestedNode {
  id: string;
  children: NestedNode[];
}

/** 矩形（布局用的轴对齐包围盒）。 */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 自包含建树：由 edges 构建 parent→children。
 *  - 首条入边 wins：同一 target 的多条入边只保留数组中第一条；
 *  - 成环防护：访问过的节点不再展开（不致死循环，环边在展开时被跳过）；
 *  - collapsed[id] = true 时，id 在嵌套树中成为叶子（后代被剔除）；
 *  - 只考虑 nodeIds 集合内的节点（子集布局）。
 */
function buildNestedTree(input: LayoutInput): { nested: NestedNode; laidOutIds: string[]; notes: string[] } {
  const nodeIds = new Set(input.nodes.map((n) => n.id));
  const notes: string[] = [];

  const childrenMap = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const e of input.edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    if (parentOf.has(e.target)) continue; // 首条入边 wins
    parentOf.set(e.target, e.source);
    const arr = childrenMap.get(e.source) ?? [];
    arr.push(e.target);
    childrenMap.set(e.source, arr);
  }
  for (const arr of childrenMap.values()) arr.sort(); // 字典序保证确定性

  const isCollapsed = (id: string): boolean => input.collapsed?.[id] === true;

  let roots = input.nodes.map((n) => n.id).filter((id) => !parentOf.has(id));
  roots.sort();
  if (input.rootId && nodeIds.has(input.rootId)) roots = [input.rootId];
  if (roots.length === 0) {
    roots = [...nodeIds].sort().slice(0, 1);
    notes.push('检测到成环输入：已按字典序强行取根，环边被截断。');
  }

  const visited = new Set<string>();
  const makeNode = (id: string): NestedNode => {
    visited.add(id);
    let kids: string[] = [];
    if (!isCollapsed(id)) {
      kids = (childrenMap.get(id) ?? []).filter((c) => !visited.has(c));
    } else {
      notes.push(`节点「${id}」折叠：其 ${(childrenMap.get(id) ?? []).length} 个后代从布局剔除。`);
    }
    return { id, children: kids.map((c) => makeNode(c)) };
  };

  let nested: NestedNode;
  if (roots.length === 1) {
    nested = makeNode(roots[0]!);
  } else {
    nested = { id: '__super_root__', children: roots.map((r) => makeNode(r)) };
    notes.push(`检测到 ${roots.length} 个根：以超根统一排布后丢弃超根节点。`);
  }

  const laidOutIds: string[] = [];
  const collect = (n: NestedNode): void => {
    if (n.id !== '__super_root__') laidOutIds.push(n.id);
    for (const c of n.children) collect(c);
  };
  collect(nested);

  return { nested, laidOutIds, notes };
}

/** 矩形重叠判定（边贴边不算重叠）。 */
function rectsOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * 树布局入口。
 * @param input  布局输入（节点/边/根/间距/实测/pinned/collapsed）
 * @param mode   P0 ∈ mindmap-right | mindmap-down | org-tree；'radial' 抛错
 * @returns LayoutResult：每个节点的世界坐标 + 碰撞报告。
 */
export function layoutTree(input: LayoutInput, mode: LayoutMode): LayoutResult {
  if (mode === 'radial') {
    throw new Error("layoutTree: 'radial' 为 P1 预留，本期未实现。");
  }
  const notes: string[] = [];

  // 1) 实测尺寸解析（缺失走默认常量）。
  const sizeOf = (id: string): MeasuredSize => input.measured[id] ?? DEFAULT_NODE_SIZE;

  // 2) 建树（自包含，不依赖 graph 模块）。
  const built = buildNestedTree(input);
  notes.push(...built.notes);

  const pinned = input.pinned ?? new Set<string>();

  // 3) d3 hierarchy + tree（tidy 排布）。pinned 节点保留在结构中作为分支锚点，
  //    但其坐标不写入输出（其后代继续在 d3 中排布）。
  const rootHierarchy = hierarchy<NestedNode>(built.nested, (d) => d.children);
  rootHierarchy.sort((a, b) => a.data.id.localeCompare(b.data.id));

  // 全局实测宽/高极值（d3 nodeSize 只能取常量，用极值占位保证不重叠）。
  let maxW = 0;
  let maxH = 0;
  for (const id of built.laidOutIds) {
    const s = sizeOf(id);
    if (s.width > maxW) maxW = s.width;
    if (s.height > maxH) maxH = s.height;
  }

  const right = mode === 'mindmap-right';

  // d3 nodeSize：[d3X 方向 pitch, d3Y 方向 pitch]。
  // - mindmap-right：d3X=我们的竖向(兄弟轴)，d3Y=我们的横向(深度轴)。
  // - mindmap-down / org-tree：d3X=横向(兄弟轴)，d3Y=纵向(深度轴)。
  let nodeSize: [number, number];
  if (right) {
    nodeSize = [maxH + input.nodeSpacing, maxW + input.rankSpacing];
  } else if (mode === 'org-tree') {
    nodeSize = [maxW + input.nodeSpacing, 1]; // dy=1 仅作深度索引，行高稍后自算
  } else {
    nodeSize = [maxW + input.nodeSpacing, maxH + input.rankSpacing];
  }

  const layout = tree<NestedNode>().nodeSize(nodeSize);
  const pointRoot = layout(rootHierarchy);

  // 4) d3 坐标 → 世界左上角。
  const worldBoxes = new Map<string, Box>();

  // org-tree：先按深度行统计行最大高，再累计行顶。
  const rowMaxH = new Map<number, number>();
  pointRoot.each((n) => {
    const id = n.data.id;
    if (id === '__super_root__' || pinned.has(id)) return;
    const d = n.depth;
    const s = sizeOf(id);
    if ((rowMaxH.get(d) ?? 0) < s.height) rowMaxH.set(d, s.height);
  });
  const maxDepth = Math.max(0, ...[...rowMaxH.keys()]);
  const rowTopAt = new Map<number, number>();
  let acc = 0;
  for (let d = 0; d <= maxDepth; d++) {
    rowTopAt.set(d, acc);
    acc += (rowMaxH.get(d) ?? 0) + input.nodeSpacing;
  }

  pointRoot.each((n) => {
    const id = n.data.id;
    if (id === '__super_root__' || pinned.has(id)) return;
    const s = sizeOf(id);
    const d3x = n.x;
    const d3y = n.y;
    let left: number;
    let top: number;
    if (right) {
      // 输出 x=d3.y（深度向右）、y=d3.x（兄弟竖向），块中心落在 d3 点上。
      left = d3y - s.width / 2;
      top = d3x - s.height / 2;
    } else if (mode === 'org-tree') {
      left = d3x - s.width / 2; // 水平居中于 d3 槽位
      top = rowTopAt.get(n.depth) ?? 0; // 同层顶对齐
    } else {
      left = d3x - s.width / 2;
      top = d3y - s.height / 2;
    }
    worldBoxes.set(id, { x: left, y: top, w: s.width, h: s.height });
  });

  // 5) 坐标归一化：让被布局簇的最小左上 = (0,0)。pinned 节点不参与归一。
  let minX = Infinity;
  let minY = Infinity;
  for (const b of worldBoxes.values()) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
  }
  for (const [id, b] of worldBoxes) {
    worldBoxes.set(id, { x: b.x - minX, y: b.y - minY, w: b.w, h: b.h });
  }

  // 6) 注入 pinned 节点（锚点 = BlockNode.x/.y，坐标不变）。
  for (const id of pinned) {
    const bn = input.nodes.find((n) => n.id === id);
    if (!bn) continue;
    const s = sizeOf(id);
    worldBoxes.set(id, { x: bn.x, y: bn.y, w: s.width, h: s.height });
  }

  // 7) pinned 绕行：被布局节点与 pinned 矩形重叠时，沿布局轴最小平移避让。
  //    right 模式推 y（竖向），down/org 模式推 x（横向）；最多 DETOUR_MAX_ROUNDS 轮。
  const detoured = new Set<string>();
  const pinnedBoxes: Box[] = [];
  for (const id of pinned) {
    const b = worldBoxes.get(id);
    if (b) pinnedBoxes.push(b);
  }
  const pushAxis: 'x' | 'y' = right ? 'y' : 'x';
  for (let round = 0; round < DETOUR_MAX_ROUNDS; round++) {
    let moved = false;
    for (const id of built.laidOutIds) {
      if (pinned.has(id)) continue;
      const box = worldBoxes.get(id);
      if (!box) continue;
      let hit = false;
      for (const p of pinnedBoxes) {
        if (!rectsOverlap(box, p)) continue;
        hit = true;
        break;
      }
      if (!hit) continue;
      const p = pinnedBoxes.find((pp) => rectsOverlap(box, pp));
      if (!p) continue;
      const gap = input.nodeSpacing * DETOUR_GAP_FACTOR;
      if (pushAxis === 'y') {
        const centerBox = box.y + box.h / 2;
        const centerP = p.y + p.h / 2;
        if (centerBox <= centerP) box.y = p.y - box.h - gap;
        else box.y = p.y + p.h + gap;
      } else {
        const centerBox = box.x + box.w / 2;
        const centerP = p.x + p.w / 2;
        if (centerBox <= centerP) box.x = p.x - box.w - gap;
        else box.x = p.x + p.w + gap;
      }
      detoured.add(id);
      moved = true;
    }
    if (!moved) break;
  }
  if (detoured.size > 0) {
    notes.push(
      `pinned 绕行：${detoured.size} 个节点被推出 pinned 遮挡（轴向 ${pushAxis === 'y' ? '竖向(y)' : '横向(x)'}，≤${DETOUR_MAX_ROUNDS} 轮）。`,
    );
  }

  // 8) 最终碰撞复检：任意一对仍重叠 → 报告。
  const ids = [...worldBoxes.keys()].sort();
  const overlappingPairs: Array<[string, string]> = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const aId = ids[i]!;
      const bId = ids[j]!;
      const a = worldBoxes.get(aId)!;
      const b = worldBoxes.get(bId)!;
      if (rectsOverlap(a, b)) overlappingPairs.push([aId, bId]);
    }
  }
  if (overlappingPairs.length > 0) {
    notes.push(`残留碰撞：${overlappingPairs.length} 对节点仍重叠（见 collisions.overlappingPairs）。`);
  }

  // 9) 输出 positions（只返回输入节点集合内的节点）。
  const positions: Record<string, LayoutPosition> = {};
  const outIds = new Set(input.nodes.map((n) => n.id));
  for (const [id, b] of worldBoxes) {
    if (!outIds.has(id)) continue;
    positions[id] = { x: b.x, y: b.y };
  }

  return {
    positions,
    collisions: { overlappingPairs, detouredNodes: [...detoured].sort() },
    notes,
  };
}

/** 类型再导出。 */
export type { LayoutMode };
