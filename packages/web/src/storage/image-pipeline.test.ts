import { describe, it, expect, vi } from 'vitest';
import { ingestImageFile, type ImageIngestDeps } from './image-pipeline';

/**
 * ingestImageFile 统一管线单测（jsdom，无真 canvas/OPFS）：
 *  - OPFS 可用 → src 存 assetRef，via='opfs'，不内联；
 *  - OPFS 返回空引用 / 抛错 → 降级 dataURL 内联，via='dataurl'，不产生坏引用。
 * 压缩层 compressImageBlob 在 jsdom 解码失败时原样返回 Blob，路径仍可走通。
 */

function deps(over: Partial<ImageIngestDeps> = {}): ImageIngestDeps {
  return {
    putImageAsset: vi.fn(async () => ({ assetRef: 'asset_x' })),
    addImageBlock: vi.fn(() => 'block_1'),
    ...over,
  };
}

const png = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

describe('ingestImageFile（统一图片管线）', () => {
  it('OPFS 可用：src 存 assetRef，via=opfs', async () => {
    const add = vi.fn(() => 'block_1');
    const r = await ingestImageFile(deps({ addImageBlock: add }), png(), 10, 20);
    expect(r.via).toBe('opfs');
    expect(r.src).toBe('asset_x');
    expect(r.blockId).toBe('block_1');
    // 建块时传的是引用 id，不是 dataURL
    expect(add).toHaveBeenCalledWith('asset_x', 10, 20);
  });

  it('OPFS 返回空 assetRef：降级 dataURL 内联，不产生坏引用', async () => {
    const add = vi.fn((_src: string, _x: number, _y: number) => 'block_2');
    const r = await ingestImageFile(
      deps({ putImageAsset: vi.fn(async () => ({ assetRef: '' })), addImageBlock: add }),
      png(),
      0,
      0,
    );
    expect(r.via).toBe('dataurl');
    expect(r.src.startsWith('data:')).toBe(true);
    // 建块拿到的是 dataURL，不是空串
    expect(add).toHaveBeenCalledTimes(1);
    const arg = add.mock.calls[0]![0];
    expect(String(arg).startsWith('data:')).toBe(true);
  });

  it('OPFS 抛错：同样降级 dataURL，不抛到 UI', async () => {
    const put = vi.fn(async () => {
      throw new Error('OPFS unavailable');
    });
    const add = vi.fn((_src: string, _x: number, _y: number) => 'block_3');
    const r = await ingestImageFile(deps({ putImageAsset: put, addImageBlock: add }), png(), 0, 0);
    expect(r.via).toBe('dataurl');
    expect(r.src.startsWith('data:')).toBe(true);
  });
});
