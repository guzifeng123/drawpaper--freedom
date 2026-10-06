import { describe, it, expect, beforeEach } from 'vitest';
import { applyHydrationDelta, resetHydrated, getHydratedSnapshot } from './hydration-store';

/**
 * hydration-store 增量逻辑单测：只测纯数据语义（add/remove/幂等/无变化不通知），
 * 不渲染组件。细粒度订阅由 useSyncExternalStore 保证。
 */
describe('hydration-store', () => {
  beforeEach(() => resetHydrated());

  it('starts empty', () => {
    expect(getHydratedSnapshot().size).toBe(0);
  });

  it('adds ids and reports change', () => {
    const changed = applyHydrationDelta(['a', 'b'], []);
    expect(changed).toBe(true);
    expect([...getHydratedSnapshot()].sort()).toEqual(['a', 'b']);
  });

  it('does not duplicate already-hydrated ids', () => {
    applyHydrationDelta(['a'], []);
    const changed = applyHydrationDelta(['a'], []);
    expect(changed).toBe(false);
    expect(getHydratedSnapshot().size).toBe(1);
  });

  it('removes ids and reports change', () => {
    applyHydrationDelta(['a', 'b'], []);
    const changed = applyHydrationDelta([], ['a']);
    expect(changed).toBe(true);
    expect([...getHydratedSnapshot()]).toEqual(['b']);
  });

  it('removing an absent id is a no-op', () => {
    applyHydrationDelta(['a'], []);
    const changed = applyHydrationDelta([], ['zzz']);
    expect(changed).toBe(false);
  });

  it('empty delta is a no-op', () => {
    expect(applyHydrationDelta([], [])).toBe(false);
  });

  it('reset clears all', () => {
    applyHydrationDelta(['a', 'b', 'c'], []);
    resetHydrated();
    expect(getHydratedSnapshot().size).toBe(0);
  });
});
