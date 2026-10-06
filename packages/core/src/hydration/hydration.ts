import type { Viewport } from '../model/index.js';

/**
 * hydration 模块：大规模文档「渐进水化」的纯几何/调度逻辑（零 DOM、零 React、确定性）。
 *
 * 背景：ReactFlow 在首 commit 时视口尺寸尚未测得，会把全部节点（如 10000 个）
 * 一次性挂载，每个 BlockShell 立即跑 `generateHTML` 静态渲染 = 十几秒长任务。
 * 本模块把「哪些块进入视口邻近需要升级为完整渲染 / 哪些块远离视口可降级回收 /
 * 升级如何分批」抽成纯函数，供 web 侧在 rAF / requestIdleCallback 里分批驱动。
 *
 * 约定坐标：x/y/width/height 均为未缩放世界坐标；viewport 为 ReactFlow 风格
 * 平移+缩放（屏幕 = (world - vp) * zoom）。
 */

/** 画布可视区域尺寸（CSS px，未缩放）。 */
export interface PaneSize {
  width: number;
  height: number;
}

/** 世界轴对齐矩形。 */
export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 带包围盒的节点最小抽象（与 BlockNode 结构兼容，纯几何）。 */
export interface BoxLike {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 屏幕可见世界矩形，四周外扩 bufferScreen（屏幕 px）。
 * 屏幕坐标 (sx,sy) → 世界：world = (sx - vp.x) / zoom。
 */
export function visibleWorldRect(vp: Viewport, pane: PaneSize, bufferScreen = 0): WorldRect {
  const z = vp.zoom > 0 ? vp.zoom : 1;
  const buf = bufferScreen / z;
  // `+ 0` 把 -0 归一为 0（viewport 在原点时）。
  return {
    x: -vp.x / z - buf + 0,
    y: -vp.y / z - buf + 0,
    width: pane.width / z + buf * 2,
    height: pane.height / z + buf * 2,
  };
}

/** 包围盒是否与矩形相交（含相切外的严格重叠；无重叠=false）。 */
export function boxIntersectsRect(box: BoxLike, rect: WorldRect): boolean {
  return (
    box.x < rect.x + rect.width &&
    box.x + box.width > rect.x &&
    box.y < rect.y + rect.height &&
    box.y + box.height > rect.y
  );
}

/** 过滤出与矩形相交的包围盒（保持原顺序）。 */
export function selectBoxesInRect<T extends BoxLike>(boxes: readonly T[], rect: WorldRect): T[] {
  const out: T[] = [];
  for (const b of boxes) if (boxIntersectsRect(b, rect)) out.push(b);
  return out;
}

/** 视口中心（世界坐标）。 */
export function viewportCenter(vp: Viewport, pane: PaneSize): { cx: number; cy: number } {
  const z = vp.zoom > 0 ? vp.zoom : 1;
  return { cx: -vp.x / z + pane.width / (2 * z), cy: -vp.y / z + pane.height / (2 * z) };
}

function boxCenter(box: BoxLike): { cx: number; cy: number } {
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

/** planHydration 的输入。 */
export interface HydrationPlanInput<T extends BoxLike> {
  boxes: readonly T[];
  viewport: Viewport;
  pane: PaneSize;
  /** 升级缓冲（屏幕 px）：与该矩形相交的块应升级为完整渲染。 */
  hydrateBufferScreen: number;
  /** 降级缓冲（屏幕 px）：超出该矩形且未保护的块可降级回占位。 */
  deactivateBufferScreen: number;
  /** 当前已水合（完整渲染）的 id。 */
  hydrated: ReadonlySet<string>;
  /** 受保护 id（编辑中 / 选中 / 拖拽）——永不降级，缺失时强制升级。 */
  protectedIds: ReadonlySet<string>;
}

export interface HydrationPlan {
  /** 待升级 id，按到视口中心距离升序（最近、最可能被读到的先升级）。 */
  toHydrate: string[];
  /** 待降级 id（安全回收为占位壳）。 */
  toDeactivate: string[];
}

/**
 * 计算一次水合调度计划：
 *  - toHydrate：与「可见+hydrateBuffer」相交、尚未水合的块，按离视口中心距离升序；
 *    受保护块即使不在缓冲内也会被强制纳入（保证编辑/选中块立即可读）。
 *  - toDeactivate：已水合、在「可见+deactivateBuffer」之外、且未受保护的块。
 *
 * 纯函数：相同输入必得相同输出；web 侧负责分批提交 toHydrate / toDeactivate。
 */
export function planHydration<T extends BoxLike>(input: HydrationPlanInput<T>): HydrationPlan {
  const { boxes, viewport, pane, hydrateBufferScreen, deactivateBufferScreen, hydrated, protectedIds } = input;
  const hydrateRect = visibleWorldRect(viewport, pane, hydrateBufferScreen);
  const deactivateRect = visibleWorldRect(viewport, pane, deactivateBufferScreen);
  const { cx, cy } = viewportCenter(viewport, pane);

  const byId = new Map<string, BoxLike>();
  for (const b of boxes) byId.set(b.id, b);

  const pending: Array<{ id: string; d: number }> = [];
  const seen = new Set<string>();
  const pushPending = (id: string) => {
    if (seen.has(id) || hydrated.has(id)) return;
    const b = byId.get(id);
    if (!b) return;
    const bc = boxCenter(b);
    pending.push({ id, d: (bc.cx - cx) ** 2 + (bc.cy - cy) ** 2 });
    seen.add(id);
  };

  // 1) 视口邻近 → 升级。
  for (const b of boxes) {
    if (boxIntersectsRect(b, hydrateRect)) pushPending(b.id);
  }
  // 2) 受保护块强制升级（编辑中 / 选中——即便此刻在缓冲外，也保证内容可读、不闪占位）。
  for (const id of protectedIds) pushPending(id);

  pending.sort((a, b) => a.d - b.d);

  // 3) 远离视口且未保护 → 降级回收。
  const toDeactivate: string[] = [];
  for (const id of hydrated) {
    if (protectedIds.has(id)) continue;
    const b = byId.get(id);
    // 文档中已不存在的 id（块被删）直接剔除，不算降级。
    if (!b) {
      toDeactivate.push(id);
      continue;
    }
    if (!boxIntersectsRect(b, deactivateRect)) toDeactivate.push(id);
  }

  return { toHydrate: pending.map((p) => p.id), toDeactivate };
}

/**
 * 把待升级 id 列表切成每片 perChunk 个（用于跨 rAF / idle 分批，避免单帧长任务）。
 * perChunk <=0 时退化为每片 1 个。
 */
export function chunkIds(ids: readonly string[], perChunk: number): string[][] {
  const n = Math.max(1, Math.floor(perChunk));
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += n) out.push(ids.slice(i, i + n));
  return out;
}

/**
 * 从 Tiptap JSON 树抽纯文本（递归，零依赖），用于离屏占位壳的摘要预览。
 * 只收集叶子 text 节点，拼接后截断到 maxLen。core 不依赖 @tiptap，形状宽松。
 */
export function extractPlainText(data: unknown, maxLen = 120): string {
  let out = '';
  const walk = (node: unknown): void => {
    if (out.length >= maxLen) return;
    if (!node || typeof node !== 'object') return;
    const n = node as { text?: string; content?: unknown[] };
    if (typeof n.text === 'string') {
      out += n.text;
      return;
    }
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
  };
  walk(data);
  return out.length > maxLen ? out.slice(0, maxLen) : out;
}
