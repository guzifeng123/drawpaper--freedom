import { describe, it, expect } from 'vitest';
import { computeResize, IMAGE_MAX_LONG_EDGE, selectOutputMime, isAssetRefSrc, sniffImageMime } from './opfs';
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

describe('selectOutputMime（格式选择纯决策）', () => {
  it('SVG 矢量原样保留（不经 canvas 栅格化）', () => {
    expect(selectOutputMime('image/svg+xml')).toBe('image/svg+xml');
    expect(selectOutputMime('IMAGE/SVG+XML')).toBe('image/svg+xml');
  });
  it('PNG 保留 PNG（无损 / 带 alpha 透明）', () => {
    expect(selectOutputMime('image/png')).toBe('image/png');
  });
  it('jpg/gif/bmp/webp 统一转 webp', () => {
    expect(selectOutputMime('image/jpeg')).toBe('image/webp');
    expect(selectOutputMime('image/gif')).toBe('image/webp');
    expect(selectOutputMime('image/bmp')).toBe('image/webp');
    expect(selectOutputMime('image/webp')).toBe('image/webp');
  });
});

describe('isAssetRefSrc（引用 vs 内联判定）', () => {
  it('assetRef（非 data/blob/http）视为引用', () => {
    expect(isAssetRefSrc('asset_abc123')).toBe(true);
    expect(isAssetRefSrc('U1basE6id')).toBe(true);
  });
  it('data:/blob:/http 视为内联，不是引用', () => {
    expect(isAssetRefSrc('data:image/png;base64,xx')).toBe(false);
    expect(isAssetRefSrc('blob:http://x/uuid')).toBe(false);
    expect(isAssetRefSrc('https://x/y.png')).toBe(false);
  });
  it('空值安全返回 false', () => {
    expect(isAssetRefSrc('')).toBe(false);
    expect(isAssetRefSrc(undefined)).toBe(false);
    expect(isAssetRefSrc(null)).toBe(false);
  });
});

describe('sniffImageMime（OPFS 读回后 mime 修正）', () => {
  it('PNG / JPEG / WEBP / SVG 按魔数识别', () => {
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png');
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
    expect(sniffImageMime(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBe('image/svg+xml');
  });
  it('未知回退 octet-stream', () => {
    expect(sniffImageMime(new Uint8Array([0x00, 0x11, 0x22]))).toBe('application/octet-stream');
  });
});
