import { useEffect, useRef } from 'react';
import { planHydration, chunkIds, type PaneSize } from '@drawpaper/core';
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
 *  3. toHydrate 按 chunkIds 切片，跨 requestIdleCallback（无则 rAF 兜底）分批升级，
 *     每批限量，主线程不被长任务阻塞。
 *
 * 保护集：当前编辑中节点 + 选中节点——永不降级，缺失时强制升级。
 */

const HYDRATE_BUFFER_SCREEN = 400;
const DEACTIVATE_BUFFER_SCREEN = 2000;
const CHUNK_PER_TICK = 12;

type CancelFn = () => void;

/** requestIdleCallback（无则 rAF 兜底），返回取消函数。 */
function scheduleIdleTick(cb: () => void): CancelFn {
  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(cb, { timeout: 200 });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = requestAnimationFrame(cb);
  return () => cancelAnimationFrame(id);
}

export function useHydrationScheduler(
  api: EditorApi,
  doc: KBNoteDoc,
  viewport: Viewport,
  paneEl: HTMLElement | null,
): void {
  // 仅在「切换到另一篇文档」时重置水合集；同一文档内增删块/打字/移动不重置。
  const prevDocIdRef = useRef<string>(doc.id);

  useEffect(() => {
    if (!paneEl) return;

    if (prevDocIdRef.current !== doc.id) {
      prevDocIdRef.current = doc.id;
      resetHydrated();
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

      // 升级跨 idle 帧分批。
      const chunks = chunkIds(plan.toHydrate, CHUNK_PER_TICK);
      let i = 0;
      const step = () => {
        if (cancelled) return;
        if (i >= chunks.length) return;
        applyHydrationDelta(chunks[i]!, []);
        i += 1;
        if (i < chunks.length) cancelIdle = scheduleIdleTick(step);
      };
      step();
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
