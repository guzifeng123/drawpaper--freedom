import { useEffect, useRef } from 'react';
import { planHydration, type PaneSize } from '@drawpaper/core';
import type { EditorApi } from '../editor-api';
import type { KBNoteDoc, Viewport } from '@drawpaper/core';
import { applyHydrationDelta, getHydratedSnapshot, resetHydrated } from './hydration-store';

/**
 * useHydrationScheduler —— 视口驱动的渐进水化调度器。
 *
 * 视口/文档变化时（rAF 合并，避免拖拽/平移逐像素 O(N) 抖动）：
 *  1. 用 core 的 planHydration 纯函数算出 toHydrate（视口邻近，按离中心距离排序）
 *     与 toDeactivate（远离视口且未保护）；
 *  2. toDeactivate 立即应用（占位壳很便宜）；
 *  3. toHydrate 按 deadline 驱动分批升级，跨 requestIdleCallback（无则 rAF 兜底），
 *     每批按真实 idle 剩余时间动态决定片长，主线程不被长任务阻塞。
 *
 * 保护集：当前编辑中节点 + 选中节点——永不降级，缺失时强制升级。
 *
 * ── 预算标定（Wave21，本机实测）────────────────────────────
 *  每节点水合成本 = applyHydrationDelta(Set 变更 + emit) ≈ <1ms 同步开销，
 *  但触发的 React 重渲染（BlockShell 占位→完整 HTML）在同一 task 批次内完成。
 *  实测 2k 块首开：React 首 commit 长任务 ~635ms（不可避免，RF 首帧不裁剪），
 *  调度器后续分批升级在 idle 帧完成，每批控制在 ≤25ms 避免追加长任务。
 */

// ── 视口缓冲（屏幕 px）─────────────────────────────────────
/** 视口外扩此距离内的块升级为完整渲染（首屏 + 滚动预判）。 */
const HYDRATE_BUFFER_SCREEN = 400;
/** 视口外扩此距离外的已水合块降级回收（越大越稳定、内存越高）。 */
const DEACTIVATE_BUFFER_SCREEN = 2000;

// ── 分片调度预算 ──────────────────────────────────────────
/** 每 idle tick 最多占用主线程的目标预算（ms）。留 25ms 远低于 50ms Long Task 阈值。 */
const MAX_IDLE_TICK_MS = 25;
/** 每 tick 最少升级节点数（即使 deadline 很紧也至少推进这么多，保证收敛）。 */
const MIN_CHUNK = 4;
/** 每 tick 最多升级节点数（防止极空闲帧一口气吃光 DOM 批量）。 */
const MAX_CHUNK = 24;
/** 首开/切档时第一批同步升级的节点数（不等 rIC，直接在 effect 里跑，抢首屏可见时间）。 */
const FIRST_TICK_IMMEDIATE = 8;
/** 首开时 rIC 超时（ms）：短超时确保浏览器一有空就升级，不等到 200ms。 */
const RIC_TIMEOUT_FIRST = 100;
/** 稳态滚动/平移时 rIC 超时（ms）：长超时让浏览器自己挑空闲时机，不抢交互帧。 */
const RIC_TIMEOUT_STEADY = 300;

type CancelFn = () => void;
interface IdleDeadlineLike {
  timeRemaining(): number;
  didTimeout: boolean;
}

/** requestIdleCallback（无则 rAF 兜底），回调收到 deadline。返回取消函数。 */
function scheduleIdleTick(
  cb: (deadline: IdleDeadlineLike) => void,
  timeoutMs: number,
): CancelFn {
  const w = window as unknown as {
    requestIdleCallback?: (cb: (d: IdleDeadlineLike) => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(cb, { timeout: timeoutMs });
    return () => w.cancelIdleCallback?.(id);
  }
  // rAF 兜底：deadline 不可知，给一个乐观的剩余时间（~12ms = 一帧预算的一半）。
  const rafDeadline: IdleDeadlineLike = { timeRemaining: () => 12, didTimeout: false };
  const id = requestAnimationFrame(() => cb(rafDeadline));
  return () => cancelAnimationFrame(id);
}

/**
 * 根据 deadline 剩余时间和预估每节点成本，动态计算本 tick 应处理多少节点。
 * 线性插值：deadline 充裕 → 接近 MAX_CHUNK；deadline 紧张 → 至少 MIN_CHUNK。
 */
function chunkSizeFromDeadline(deadlineMs: number): number {
  // 假设每节点升级 + React 重渲染 ≈ 2ms（实测占位→完整 HTML 批量成本）。
  const PER_NODE_MS = 2;
  const byTime = Math.floor(deadlineMs / PER_NODE_MS);
  return Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, byTime));
}

export function useHydrationScheduler(
  api: EditorApi,
  doc: KBNoteDoc,
  viewport: Viewport,
  paneEl: HTMLElement | null,
): void {
  // 仅在「切换到另一篇文档」时重置水合集；同一文档内增删块/打字/移动不重置。
  const prevDocIdRef = useRef<string>(doc.id);
  // 标记是否是首开（用于选择短/长 rIC 超时 + 首批同步升级）。
  const isFirstOpenRef = useRef(true);

  useEffect(() => {
    if (!paneEl) return;

    if (prevDocIdRef.current !== doc.id) {
      prevDocIdRef.current = doc.id;
      resetHydrated();
      isFirstOpenRef.current = true;
    }

    let cancelled = false;
    let cancelIdle: CancelFn = () => {};
    let rafId = 0;

    const run = () => {
      if (cancelled) return;
      const pane: PaneSize = { width: paneEl.clientWidth, height: paneEl.clientHeight };
      const s = api.getState();
      const protectedIds = new Set<string>();
      if (s.editingNodeId) protectedIds.add(s.editingNodeId);
      for (const id of s.selection) protectedIds.add(id);

      const plan = planHydration({
        boxes: doc.nodes,
        viewport,
        pane,
        hydrateBufferScreen: HYDRATE_BUFFER_SCREEN,
        deactivateBufferScreen: DEACTIVATE_BUFFER_SCREEN,
        hydrated: getHydratedSnapshot(),
        protectedIds,
      });

      // 降级立即应用（占位壳廉价，且回收内存/渲染成本）。
      if (plan.toDeactivate.length > 0) applyHydrationDelta([], plan.toDeactivate);

      if (plan.toHydrate.length === 0) {
        isFirstOpenRef.current = false;
        return;
      }

      // 首开：第一批同步升级（不等 rIC），抢首屏可见时间。
      const firstBatchSize = isFirstOpenRef.current
        ? Math.min(FIRST_TICK_IMMEDIATE, plan.toHydrate.length)
        : 0;

      let idx = 0;
      if (firstBatchSize > 0) {
        const firstChunk = plan.toHydrate.slice(0, firstBatchSize);
        applyHydrationDelta(firstChunk, []);
        idx = firstBatchSize;
      }

      // 后续批次：deadline 驱动。
      const remaining = plan.toHydrate.slice(idx);
      if (remaining.length === 0) {
        isFirstOpenRef.current = false;
        return;
      }

      const timeoutMs = isFirstOpenRef.current ? RIC_TIMEOUT_FIRST : RIC_TIMEOUT_STEADY;
      isFirstOpenRef.current = false;

      const step = (deadline: IdleDeadlineLike) => {
        if (cancelled) return;
        if (remaining.length === 0) return;

        // 动态片长：按 deadline 剩余时间算，不超过 MAX_CHUNK，不低于 MIN_CHUNK。
        const budget = deadline.timeRemaining();
        const n = chunkSizeFromDeadline(Math.min(budget, MAX_IDLE_TICK_MS));
        const batch = remaining.splice(0, n);
        applyHydrationDelta(batch, []);

        if (remaining.length > 0) {
          cancelIdle = scheduleIdleTick(step, RIC_TIMEOUT_STEADY);
        }
      };

      // 首批同步跑完后，下一批走 idle（让浏览器先 paint 首屏）。
      cancelIdle = scheduleIdleTick(step, timeoutMs);
    };

    // rAF 合并：一帧内多次视口变化只算一次 plan。
    rafId = requestAnimationFrame(run);

    return () => {
      cancelled = true;
      cancelIdle();
      cancelAnimationFrame(rafId);
    };
  }, [api, doc, viewport, paneEl]);
}
