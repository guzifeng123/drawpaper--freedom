/**
 * Wave24 路 3：前端冷启动分段埋点。
 *
 * 设计约束（与任务书红线一致）：
 *  - 零外网、零新依赖；仅用 Performance Timeline（mark/measure/observer）。
 *  - 时间基统一 performance.timeOrigin（= navigation start）；
 *    每个关键段打 `performance.mark('ds:<name>')`，成对段补 `measure`。
 *    无人读取时成本≈0，且 dev / production preview 都可经
 *    `performance.getEntriesByType('mark'|'measure')` 读到——不依赖 __drawpaper__ DEV 钩子。
 *  - 全局只读快照挂 `window.__coldStart`（report() 纯读时间线），
 *    供 Playwright 采集脚本与 Tauri devtools 手动采集（见 docs/wave24/web-coldstart.md）。
 *
 * 分段字典（name → 触发点）：
 *   boot              main.tsx 模块求值起点
 *   store             editor-store 单例创建完成
 *   bootstrap         bootstrap() 启动（listDocs 之前）
 *   idb-open          首次 IDB 操作完成（= Dexie 打开 + listDocs 回来）
 *   doc-open          最近一份文档载入 store（openDoc / newDoc 完成）
 *   bootstrap-done    bootstrap() 收尾（restoreActiveFile / 配额预检派发之后）
 *   search-index      首份 MiniSearch 索引建成
 *   collab            collabManager.install() 返回
 *   sync-restore      syncController.restore() 落定
 *   asset-reconcile   reconcileAssetRefs() 落定
 *   render-start      ReactDOM.render 调用
 *   react-commit      App 首个 effect（= 首次 commit 后）
 *   canvas-frame      首个 rAF 双帧后画布 pane 已挂载（空文档=画布壳；有文档=首批节点上屏）
 *   tti               首帧后连续可交互窗口（见 armTTIWatch 定义）
 */

const MARK_PREFIX = 'ds:';

type PerfEntryLike = { name: string; startTime: number; duration?: number };

function safeMark(name: string): void {
  try {
    performance.mark(MARK_PREFIX + name);
  } catch {
    /* 极老浏览器忽略 */
  }
}

/** 打一个冷启动分段时间戳（相对 timeOrigin，ms）。 */
export function mark(name: string): void {
  safeMark(name);
  if (name === 'canvas-frame') armTTIWatch();
}

/** 成对段计时：measure(name) = endMark - startMark（ms）。 */
export function timed<T>(name: string, startMark: string, p: Promise<T>): Promise<T> {
  safeMark(startMark);
  return p.then(
    (v) => {
      try {
        performance.measure(MARK_PREFIX + name, MARK_PREFIX + startMark);
      } catch {
        /* ignore */
      }
      return v;
    },
    (e: unknown) => {
      try {
        performance.measure(MARK_PREFIX + name, MARK_PREFIX + startMark);
      } catch {
        /* ignore */
      }
      throw e;
    },
  );
}

// ── TTI：首帧后的连续可交互窗口 ───────────────────────────────
// 定义（与 performance.spec 的 TTI 口径对齐到「首屏已上屏 + 主线程安静」）：
//   canvas-frame 之后，每当出现一个 >50ms 的 Long Task 就重新对齐；
//   连续 500ms 无 Long Task（或 requestIdleCallback 首次空闲、兜底 2.5s 超时）即记 tti。
let ttiArmed = false;
let ttiTimer: ReturnType<typeof setTimeout> | undefined;

function armTTIWatch(): void {
  if (ttiArmed || typeof window === 'undefined') return;
  ttiArmed = true;

  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
    PerformanceObserver?: typeof PerformanceObserver;
  };

  const fire = () => {
    if (ttiTimer) clearTimeout(ttiTimer);
    safeMark('tti');
  };

  const schedule = () => {
    if (ttiTimer) clearTimeout(ttiTimer);
    if (typeof w.requestIdleCallback === 'function') {
      w.requestIdleCallback(fire, { timeout: 2500 });
    } else {
      ttiTimer = setTimeout(fire, 500);
    }
  };

  // Long Task 打断安静窗口 → 重新对齐。
  const LO = w.PerformanceObserver;
  if (LO) {
    try {
      const obs = new LO((list) => {
        for (const e of list.getEntries()) {
          if (e.duration > 50) schedule();
        }
      });
      obs.observe({ entryTypes: ['longtask'] });
    } catch {
      /* noop */
    }
  }

  schedule();
}

// ── 快照汇总（供 e2e / Tauri devtools 手动采集）──────────────

export interface ColdStartReport {
  /** 各 mark → 相对 timeOrigin 的毫秒时间戳。 */
  marks: Record<string, number>;
  /** 各成对 measure → 毫秒时长。 */
  measures: Record<string, number>;
  /** 导航关键时点（ms，相对 timeOrigin）。 */
  navigation: {
    domContentLoaded: number | null;
    load: number | null;
    responseEnd: number | null;
    /** transferSize=0 表示由 SW/HTTP 缓存提供（首包无网络字节）。 */
    transferSize: number;
    encodedBodySize: number;
  };
  /** first-contentful-paint（ms）。 */
  fcp: number | null;
  /** 是否被 Service Worker 控制。 */
  swControlled: boolean;
  /** 首帧后观察到的 Long Task 时长列表（ms）。 */
  longTasks: number[];
}

const observedLongTasks: number[] = [];

/** 在采样窗口内被动记录 Long Task（独立于 TTI 打断逻辑，供报告统计）。 */
export function startLongTaskRecorder(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { PerformanceObserver?: typeof PerformanceObserver };
  if (!w.PerformanceObserver) return;
  try {
    const obs = new w.PerformanceObserver((list) => {
      for (const e of list.getEntries()) observedLongTasks.push(Math.round(e.duration));
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch {
    /* noop */
  }
}

function readNavigation() {
  const nav = performance.getEntriesByType('navigation')[0] as
    | (PerformanceNavigationTiming & { transferSize: number; encodedBodySize: number })
    | undefined;
  if (!nav) {
    return { domContentLoaded: null, load: null, responseEnd: null, transferSize: 0, encodedBodySize: 0 };
  }
  return {
    domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
    load: Math.round(nav.loadEventEnd),
    responseEnd: Math.round(nav.responseEnd),
    transferSize: Math.round(nav.transferSize),
    encodedBodySize: Math.round(nav.encodedBodySize),
  };
}

function readFcp(): number | null {
  for (const e of performance.getEntriesByType('paint')) {
    if (e.name === 'first-contentful-paint') return Math.round(e.startTime);
  }
  return null;
}

/** 汇总当前冷启动时间线（可在任意时刻调用；TTI 后调用最完整）。 */
export function getColdStartReport(): ColdStartReport {
  const marks: Record<string, number> = {};
  for (const e of performance.getEntriesByType('mark') as PerfEntryLike[]) {
    if (e.name.startsWith(MARK_PREFIX)) marks[e.name.slice(MARK_PREFIX.length)] = Math.round(e.startTime);
  }
  const measures: Record<string, number> = {};
  for (const e of performance.getEntriesByType('measure') as PerfEntryLike[]) {
    if (e.name.startsWith(MARK_PREFIX)) measures[e.name.slice(MARK_PREFIX.length)] = Math.round(e.duration ?? 0);
  }
  return {
    marks,
    measures,
    navigation: readNavigation(),
    fcp: readFcp(),
    swControlled:
      typeof navigator !== 'undefined' && !!navigator.serviceWorker && !!navigator.serviceWorker.controller,
    longTasks: observedLongTasks.slice(),
  };
}

// 全局只读快照：dev / preview 都挂，供采集脚本与 Tauri devtools 手动读取。
if (typeof window !== 'undefined') {
  const w = window as unknown as { __coldStart?: { report: () => ColdStartReport } };
  w.__coldStart = { report: getColdStartReport };
  startLongTaskRecorder();
}
