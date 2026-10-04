import { describe, it, expect } from 'vitest';
import { computeResize, IMAGE_MAX_LONG_EDGE } from './opfs';
import { ActiveFileManager, isFsaSupported } from './fsa';

describe('computeResize（纯尺寸决策）', () => {
  it('长边未超过上限时返回 null（不缩放）', () => {
    expect(computeResize(IMAGE_MAX_LONG_EDGE, 1200, 800)).toBeNull();
    expect(computeResize(IMAGE_MAX_LONG_EDGE, 1600, 900)).toBeNull();
  });

  it('长边超过上限时等比缩放到长边=1600', () => {
    // 横图 3200x2000 → 1600x1000
    expect(computeResize(IMAGE_MAX_LONG_EDGE, 3200, 2000)).toEqual({ width: 1600, height: 1000 });
    // 竖图 2000x3200 → 1000x1600
    expect(computeResize(IMAGE_MAX_LONG_EDGE, 2000, 3200)).toEqual({ width: 1000, height: 1600 });
  });

  it('非法尺寸返回 null', () => {
    expect(computeResize(IMAGE_MAX_LONG_EDGE, 0, 0)).toBeNull();
    expect(computeResize(IMAGE_MAX_LONG_EDGE, NaN, 100)).toBeNull();
  });
});

describe('FSA 能力检测与降级', () => {
  it('jsdom 环境不支持 File System Access', () => {
    expect(isFsaSupported()).toBe(false);
  });

  it('无活动句柄时 writeActiveFile 返回 false（降级为纯 IndexedDB）', async () => {
    const mgr = new ActiveFileManager();
    expect(await mgr.writeActiveFile('{}')).toBe(false);
  });
});
