import { cluster, hierarchy, tree } from 'd3-hierarchy';
import type { HierarchyNode, HierarchyPointNode } from 'd3-hierarchy';
import type { BlockNode, Edge, LayoutMode } from '../model/index.js';

/**
 * layout 模块：d3-hierarchy 驱动的纯函数树布局（零 DOM、确定性输出）。
 *
 * 支持四种模式（见 model/layout.ts 的 LayoutMode）：
 *  - `mindmap-right`：思维导图横向，根在左、子树向右展开（深度轴 = x）。
 *  - `mindmap-down`：思维导图纵向，根在上、子树向下展开（深度轴 = y），
 *    纵向行距由「逐节点实测高度 + rankSpacing」驱动（每个节点占据自己的高度槽）。
 *  - `org-tree`：组织结构树，与 mindmap-down 同方向（根在上），但采用
 *    **固定行高对齐**——每一行的高度取该行内最大实测高 + nodeSpacing，
 *    同层节点顶对齐、父节点水平居中于其子树之上。
 *    （与 mindmap-down 的差异：mindmap-down 的纵向 pitch 随每个节点实测高变化，
 *     org-tree 则按行统一取最大行高，行外观更整齐、行距恒定。）
 *  - `radial`：放射（极坐标）树——根在圆心、深度 = 环半径、同层按叶子跨度均分角度。
 *    由 d3-hierarchy `cluster()` 算出 tidy 叶子分布后映射为极坐标
 *    （x=cx+r·sinθ, y=cy+r·cosθ）。详见 layoutRadial 的近似与局限 JSDoc。
 *
 * 增量整理见 {@link layoutTreeIncremental}；折叠收紧见 {@link LayoutInput.tighten}。
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
  /**
   * manualFixed 节点集合：与 pinned 同处理（坐标保持不变、布局在其周围绕行），
   * 但语义独立——pinned 表示「用户钉死不参与整理」，manualFixed 表示「用户手动微调过、
   * 增量整理时保留原位」。二者在 notes 中分别说明。
   */
  manualFixed?: ReadonlySet<string>;
  /** collapsedMap：id → 是否折叠；折叠子树收为一个单位，不展开内部后代。 */
  collapsed?: Readonly<Record<string, boolean>>;
  /**
   * tighten：折叠/删除后重排时消除大片空隙（默认 false，保持 P0 紧凑度）。
   * - true 时：同级兄弟按**实测宽**而非全局极值占位排布，折叠掉大子树后兄弟分支
   *   向心收拢，包围盒更紧凑；仍保证 AABB 不重叠（重叠进 collisions.overlappingPairs）。
   * - 仅对 mindmap-right / mindmap-down / org-tree 生效；radial 下仅影响环间距注释。
   */
  tighten?: boolean;
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
 * @param input  布局输入（节点/边/根/间距/实测/pinned/manualFixed/collapsed/tighten）
 * @param mode   ∈ mindmap-right | mindmap-down | org-tree | radial
 * @returns LayoutResult：每个节点的世界坐标 + 碰撞报告。
 */
export function layoutTree(input: LayoutInput, mode: LayoutMode): LayoutResult {
  const notes: string[] = [];

  // 1) 实测尺寸解析（缺失走默认常量）。
  const sizeOf = (id: string): MeasuredSize => input.measured[id] ?? DEFAULT_NODE_SIZE;

  // 2) 建树（自包含，不依赖 graph 模块）。
  const built = buildNestedTree(input);
  notes.push(...built.notes);

  // pinned 与 manualFixed 同作为「固定锚点」参与避让/绕行，但语义独立、notes 分列。
  const pinned = input.pinned ?? new Set<string>();
  const manualFixed = input.manualFixed ?? new Set<string>();
  const fixedSet = new Set<string>([...pinned, ...manualFixed]);
  if (manualFixed.size > 0) {
    notes.push(`manualFixed：${manualFixed.size} 个节点保持手动坐标（与 pinned 独立）。`);
  }

  // 3) d3 hierarchy（tidy 排布）。固定锚点节点保留在结构中作为分支锚点，
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
  const worldBoxes = new Map<string, Box>();

  if (mode === 'radial') {
    // ---- 放射（极坐标）树：见文件末尾 layoutRadial 近似说明 ----
    layoutRadialInto(rootHierarchy, sizeOf, fixedSet, input, worldBoxes);
  } else {
    // ---- 笛卡尔三模式 ----
    // tighten：按实测宽紧凑排布（separation 用真实宽度），否则用全局极值常量槽位。
    let nodeSize: [number, number];
    let separation:
      | ((a: HierarchyPointNode<NestedNode>, b: HierarchyPointNode<NestedNode>) => number)
      | undefined;
    if (input.tighten) {
      // nodeSize=[1,1] 单位即 px；separation 决定相邻叶子中心距 = (w_a+w_b)/2 + nodeSpacing。
      nodeSize = [1, 1];
      separation = (a, b) => {
        const wa = sizeOf(a.data.id).width;
        const wb = sizeOf(b.data.id).width;
        return (wa + wb) / 2 + input.nodeSpacing;
      };
      notes.push('tighten：同级按实测宽紧凑排布（折叠后兄弟向心收拢）。');
    } else if (right) {
      nodeSize = [maxH + input.nodeSpacing, maxW + input.rankSpacing];
    } else if (mode === 'org-tree') {
      nodeSize = [maxW + input.nodeSpacing, 1]; // dy=1 仅作深度索引，行高稍后自算
    } else {
      nodeSize = [maxW + input.nodeSpacing, maxH + input.rankSpacing];
    }

    const layout = tree<NestedNode>().nodeSize(nodeSize);
    if (separation) layout.separation(separation);
    const pointRoot = layout(rootHierarchy);

    // org-tree / tighten：先按深度行统计行最大高，再累计行顶。
    const rowMaxH = new Map<number, number>();
    pointRoot.each((n) => {
      const id = n.data.id;
      if (id === '__super_root__' || fixedSet.has(id)) return;
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
      if (id === '__super_root__' || fixedSet.has(id)) return;
      const s = sizeOf(id);
      const d3x = n.x;
      const d3y = n.y;
      let left: number;
      let top: number;
      if (right) {
        // 输出 x=d3.y（深度向右）、y=d3.x（兄弟竖向），块中心落在 d3 点上。
        left = d3y - s.width / 2;
        top = d3x - s.height / 2;
      } else if (mode === 'org-tree' || input.tighten) {
        // org-tree 与 tighten 都用行高累计；tighten 下 d3x 已是 px 中心。
        left = d3x - s.width / 2; // 水平居中于 d3 槽位
        top = rowTopAt.get(n.depth) ?? 0; // 同层顶对齐
      } else {
        left = d3x - s.width / 2;
        top = d3y - s.height / 2;
      }
      worldBoxes.set(id, { x: left, y: top, w: s.width, h: s.height });
    });
  }

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

  // 6) 注入固定锚点节点（pinned ∪ manualFixed；锚点 = BlockNode.x/.y，坐标不变）。
  for (const id of fixedSet) {
    const bn = input.nodes.find((n) => n.id === id);
    if (!bn) continue;
    const s = sizeOf(id);
    worldBoxes.set(id, { x: bn.x, y: bn.y, w: s.width, h: s.height });
  }

  // 7) 固定锚点绕行：被布局节点与锚点矩形重叠时，沿布局轴最小平移避让。
  //    right 模式推 y（竖向），down/org 模式推 x（横向）；最多 DETOUR_MAX_ROUNDS 轮。
  const detoured = new Set<string>();
  const pinnedBoxes: Box[] = [];
  for (const id of fixedSet) {
    const b = worldBoxes.get(id);
    if (b) pinnedBoxes.push(b);
  }
  const pushAxis: 'x' | 'y' = right ? 'y' : 'x';
  for (let round = 0; round < DETOUR_MAX_ROUNDS; round++) {
    let moved = false;
    for (const id of built.laidOutIds) {
      if (fixedSet.has(id)) continue;
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
      `固定锚点绕行：${detoured.size} 个节点被推出 pinned/manualFixed 遮挡（轴向 ${pushAxis === 'y' ? '竖向(y)' : '横向(x)'}，≤${DETOUR_MAX_ROUNDS} 轮）。`,
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

/**
 * 放射（极坐标）树：把 d3-hierarchy `cluster()` 的 tidy 叶子分布映射为极坐标。
 *
 * 近似算法（确定性）：
 *  1. `cluster().size([2π, 1])`：d3.x ∈ [0, 2π] 直接作角度（绕满整圆，叶子不再回卷相撞）；
 *     d3.y ∈ [0,1] 为归一化深度（弃用，改用我们自己的环半径）。
 *  2. 环半径 ringR[d]：depth 0 在圆心 r=0；第一环 ringR[1] = maxW + nodeSpacing
 *     （让根节点方框四周留出一圈，避免根与环 1 节点矩形相切/重叠）；
 *     其后每向外一层加 `rankSpacing + 该层最大实测高`（环间距 = rankSpacing + 层最大尺寸）。
 *  3. 角度居中：theta = d3.x − π，使整簇关于圆心上下对称。
 *  4. 极坐标 → 直角：`cx = r·sinθ, cy = r·cosθ`；块中心落在 (cx,cy)，左上角 = 中心 − 半宽/半高。
 *
 * 局限（JSDoc 声明，供 Wave4 知晓）：
 *  - 节点矩形是轴对齐而非沿切向摆放；叶子绕满整圆后相邻弧长在最外环最大、内环最小，
 *    内环小分支组在极端不等尺寸下仍可能轻微重叠（由最终 AABB 碰撞复检报告，不静默）。
 *  - 环间距用「该层最大实测高」近似，不等高树的环高非最小包围。
 *  - 多根（森林）时超根被丢弃，真实根落在 ringR[1] 上，圆心留空。
 */
function layoutRadialInto(
  rootHierarchy: HierarchyNode<NestedNode>,
  sizeOf: (id: string) => MeasuredSize,
  fixedSet: ReadonlySet<string>,
  input: LayoutInput,
  worldBoxes: Map<string, Box>,
): void {
  // 逐深度环最大高 + 全局最大宽
  const ringMaxH = new Map<number, number>();
  let maxW = 0;
  rootHierarchy.each((n) => {
    const id = n.data.id;
    if (id === '__super_root__' || fixedSet.has(id)) return;
    const s = sizeOf(id);
    const d = n.depth;
    if ((ringMaxH.get(d) ?? 0) < s.height) ringMaxH.set(d, s.height);
    if (s.width > maxW) maxW = s.width;
  });
  const maxDepth = Math.max(0, ...[...ringMaxH.keys()]);

  // 环半径：第一环放宽到 maxW+nodeSpacing（让根方框四周留出一圈），其后按层高累计。
  const ringR = new Map<number, number>();
  ringR.set(0, 0);
  if (maxDepth >= 1) ringR.set(1, maxW + input.nodeSpacing);
  for (let d = 2; d <= maxDepth; d++) {
    const prev = ringR.get(d - 1) ?? 0;
    ringR.set(d, prev + input.rankSpacing + (ringMaxH.get(d - 1) ?? 0));
  }

  // size([2π, 1])：叶子绕满整圆；x 即角度（弧度），y 归一化深度（弃用）。
  const clustered: HierarchyPointNode<NestedNode> =
    cluster<NestedNode>().size([2 * Math.PI, 1])(rootHierarchy);

  clustered.each((n) => {
    const id = n.data.id;
    if (id === '__super_root__' || fixedSet.has(id)) return;
    const s = sizeOf(id);
    const theta = n.x - Math.PI; // 居中到 [-π, π]
    const r = ringR.get(n.depth) ?? 0;
    const cx = r * Math.sin(theta);
    const cy = r * Math.cos(theta);
    worldBoxes.set(id, { x: cx - s.width / 2, y: cy - s.height / 2, w: s.width, h: s.height });
  });
}

/**
 * 增量整理输入：在 {@link LayoutInput} 基础上给出受影响子树根集合。
 */
export interface IncrementalLayoutInput extends LayoutInput {
  /**
   * 受影响子树的根 id 集合（新增/移动/改父子关系的节点由调用方——Wave4 store——给出）。
   * 缺省（undefined 或空集合）= 全量重排，等价于直接调 {@link layoutTree}。
   * 语义契约：集合内每个根的**整棵子树**（按当前 edges）参与重排；其余节点保持原坐标。
   */
  changedRootIds?: ReadonlySet<string>;
}

/**
 * 增量整理：只重排受影响子树，未受影响分支保持 `current.positions` 原坐标（逐字节回填）。
 *
 * 契约（供 store/编辑器 Wave4 接线）：
 *  - `current.positions`：上一次布局结果。
 *  - 受影响集合 = 各 `changedRootId` 的子树并集（按 input.edges 推导，含自身）。
 *  - 「冻结节点」= 本次会被布局、但不在受影响集合、且在 current 中有旧坐标的节点；
 *    它们被当作 pinned 锚点注入（BlockNode.x/y = current 旧坐标），布局在其周围绕行，
 *    输出坐标严格等于 current.positions[id]（双重回填保证逐字节不变）。
 *  - 受影响节点走完整 d3 重排；与冻结锚点重叠时沿用 pinned/manualFixed 避让。
 *  - 输出仍是完整 positions（未变部分原样回填）；确定性、可单测。
 *
 * @param current  上一次布局（只需 positions）。
 * @param input    增量输入（含 changedRootIds）。
 * @param mode     布局模式。
 */
export function layoutTreeIncremental(
  current: { positions: Record<string, LayoutPosition> },
  input: IncrementalLayoutInput,
  mode: LayoutMode,
): LayoutResult {
  const changed = input.changedRootIds;
  // 缺省全量：直接委托。
  if (!changed || changed.size === 0) {
    return layoutTree(input, mode);
  }

  // 1) 由 edges 推父子映射（与 buildNestedTree 同构：首条入边 wins，仅子集内节点）。
  const nodeIds = new Set(input.nodes.map((n) => n.id));
  const childrenMap = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const e of input.edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    if (parentOf.has(e.target)) continue;
    parentOf.set(e.target, e.source);
    const arr = childrenMap.get(e.source) ?? [];
    arr.push(e.target);
    childrenMap.set(e.source, arr);
  }

  // 2) BFS 求受影响集合（changedRootIds 的子树并集）。
  const affected = new Set<string>();
  const queue: string[] = [...changed].filter((id) => nodeIds.has(id));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    affected.add(id);
    for (const c of childrenMap.get(id) ?? []) queue.push(c);
  }

  // 3) 冻结节点 = 不在受影响集合、且 current 中有旧坐标的节点。
  const frozen = new Set<string>();
  for (const id of nodeIds) {
    if (affected.has(id)) continue;
    if (current.positions[id] !== undefined) frozen.add(id);
  }

  // 4) 冻结节点把 BlockNode.x/y 钉到 current 旧坐标，并并入固定锚点集合。
  const nodes = input.nodes.map((n) => {
    const p = frozen.has(n.id) ? current.positions[n.id] : undefined;
    if (p) return { ...n, x: p.x, y: p.y };
    return n;
  });
  const anchorSet = new Set<string>([
    ...frozen,
    ...(input.pinned ?? []),
    ...(input.manualFixed ?? []),
  ]);

  const modified: LayoutInput = {
    ...input,
    nodes,
    pinned: anchorSet,
  };

  const result = layoutTree(modified, mode);

  // 5) 双重回填：冻结节点输出严格等于 current.positions（逐字节）。
  for (const id of frozen) {
    const p = current.positions[id];
    if (p) result.positions[id] = { x: p.x, y: p.y };
  }
  result.notes.push(
    `增量整理：受影响根 [${[...changed].sort().join(', ')}]（${affected.size} 节点重排），${frozen.size} 节点保持原坐标。`,
  );
  return result;
}

/** 类型再导出。 */
export type { LayoutMode };
