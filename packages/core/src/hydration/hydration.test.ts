import { describe, it, expect } from 'vitest';
import {
  visibleWorldRect,
  boxIntersectsRect,
  selectBoxesInRect,
  planHydration,
  chunkIds,
  extractPlainText,
  viewportCenter,
  type BoxLike,
} from './hydration.js';
import type { Viewport } from '../model/index.js';

function box(id: string, x: number, y: number, w = 100, h = 50): BoxLike {
  return { id, x, y, width: w, height: h };
}

const pane = { width: 1000, height: 500 };

describe('visibleWorldRect', () => {
  it('maps screen pane to world rect at zoom 1', () => {
    const vp: Viewport = { x: 0, y: 0, zoom: 1 };
    expect(visibleWorldRect(vp, pane, 0)).toEqual({ x: 0, y: 0, width: 1000, height: 500 });
  });

  it('applies pan offset', () => {
    const vp: Viewport = { x: -100, y: -50, zoom: 1 };
    const r = visibleWorldRect(vp, pane, 0);
    expect(r.x).toBeCloseTo(100);
    expect(r.y).toBeCloseTo(50);
  });

  it('divides buffer by zoom (world buffer grows when zoomed out)', () => {
    const vp: Viewport = { x: 0, y: 0, zoom: 0.5 };
    const r = visibleWorldRect(vp, pane, 100);
    // pane/zoom = 2000x1000; buffer 100 screen px = 200 world px each side.
    expect(r.width).toBeCloseTo(2000 + 400);
    expect(r.x).toBeCloseTo(-200);
  });

  it('handles zoom <= 0 defensively', () => {
    const r = visibleWorldRect({ x: 0, y: 0, zoom: 0 }, pane, 0);
    expect(r.width).toBe(1000);
  });
});

describe('boxIntersectsRect / selectBoxesInRect', () => {
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  it('detects overlap and excludes disjoint', () => {
    expect(boxIntersectsRect(box('a', 10, 10), rect)).toBe(true);
    expect(boxIntersectsRect(box('b', 200, 200), rect)).toBe(false);
    // 相切边界不算相交（严格重叠）
    expect(boxIntersectsRect(box('c', 100, 0), rect)).toBe(false);
  });
  it('filters in order', () => {
    const all = [box('a', 10, 10), box('b', 500, 500), box('c', 50, 50)];
    expect(selectBoxesInRect(all, rect).map((b) => b.id)).toEqual(['a', 'c']);
  });
});

describe('planHydration', () => {
  // 视口覆盖世界 y∈[0,500]。a 在内，b 紧贴边缘外，c 很远。
  const boxes = [
    box('a', 100, 100),
    box('b', 100, 900), // 500 外 400px
    box('c', 100, 5000),
  ];
  const vp: Viewport = { x: 0, y: 0, zoom: 1 };

  it('hydrates boxes in buffer, skips far ones', () => {
    const plan = planHydration({
      boxes,
      viewport: vp,
      pane,
      hydrateBufferScreen: 50,
      deactivateBufferScreen: 500,
      hydrated: new Set<string>(),
      protectedIds: new Set<string>(),
    });
    expect(plan.toHydrate).toContain('a');
    expect(plan.toHydrate).not.toContain('c');
  });

  it('orders toHydrate by distance to viewport center (nearest first)', () => {
    const many = [box('far', 0, 400), box('near', 400, 200), box('center', 450, 225)];
    const plan = planHydration({
      boxes: many,
      viewport: vp,
      pane,
      hydrateBufferScreen: 10_000,
      deactivateBufferScreen: 0,
      hydrated: new Set<string>(),
      protectedIds: new Set<string>(),
    });
    expect(plan.toHydrate[0]).toBe('center');
  });

  it('never re-hydrates already-hydrated boxes', () => {
    const plan = planHydration({
      boxes,
      viewport: vp,
      pane,
      hydrateBufferScreen: 50,
      deactivateBufferScreen: 500,
      hydrated: new Set(['a']),
      protectedIds: new Set<string>(),
    });
    expect(plan.toHydrate).not.toContain('a');
  });

  it('forces protected ids into toHydrate even outside buffer', () => {
    const plan = planHydration({
      boxes,
      viewport: vp,
      pane,
      hydrateBufferScreen: 10,
      deactivateBufferScreen: 500,
      hydrated: new Set<string>(),
      protectedIds: new Set(['c']),
    });
    expect(plan.toHydrate).toContain('c');
  });

  it('deactivates far hydrated boxes but protects editing/selected', () => {
    const plan = planHydration({
      boxes,
      viewport: vp,
      pane,
      hydrateBufferScreen: 10,
      deactivateBufferScreen: 200,
      hydrated: new Set(['a', 'b', 'c']),
      protectedIds: new Set(['c']),
    });
    // a 在视口内→保留；b 在 200 buffer 外→降级；c 受保护→保留。
    expect(plan.toDeactivate).toContain('b');
    expect(plan.toDeactivate).not.toContain('a');
    expect(plan.toDeactivate).not.toContain('c');
  });

  it('drops hydrated ids that no longer exist in boxes', () => {
    const plan = planHydration({
      boxes,
      viewport: vp,
      pane,
      hydrateBufferScreen: 0,
      deactivateBufferScreen: 0,
      hydrated: new Set(['ghost']),
      protectedIds: new Set<string>(),
    });
    expect(plan.toDeactivate).toContain('ghost');
  });
});

describe('chunkIds', () => {
  it('chunks evenly', () => {
    expect(chunkIds(['1', '2', '3', '4', '5'], 2)).toEqual([['1', '2'], ['3', '4'], ['5']]);
  });
  it('degenerates to per-1 for bad input', () => {
    expect(chunkIds(['a', 'b'], 0)).toEqual([['a'], ['b']]);
  });
});

describe('extractPlainText', () => {
  it('walks nested taptap json and joins text leaves', () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '!' }] },
      ],
    };
    expect(extractPlainText(json)).toBe('Hello world!');
  });
  it('truncates to maxLen', () => {
    const json = { type: 'doc', content: [{ type: 'text', text: 'abcdefgh' }] };
    expect(extractPlainText(json, 3)).toBe('abc');
  });
  it('is safe on junk input', () => {
    expect(extractPlainText(null)).toBe('');
    expect(extractPlainText(undefined)).toBe('');
    expect(extractPlainText('nope')).toBe('');
  });
});

describe('viewportCenter', () => {
  it('computes center world point', () => {
    const vp: Viewport = { x: 0, y: 0, zoom: 2 };
    expect(viewportCenter(vp, pane)).toEqual({ cx: 250, cy: 125 });
  });
});
