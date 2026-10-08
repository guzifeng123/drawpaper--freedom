import { describe, it, expect, vi } from 'vitest';
import { ingestImageFile, type ImageIngestDeps } from './image-pipeline';
import { OpfsUnavailableError } from './opfs';

/**
 * ingestImageFile 统一管线单测（jsdom，无真 canvas/OPFS）：
 *  - OPFS 可用 → src 存 assetRef，via='opfs'，不内联；
 *  - OPFS 返回空引用 / 抛错 → 降级 dataURL 内联，via='dataurl'，不产生坏引用。
 * 压缩层 compressImageBlob 在 jsdom 解码失败时原样返回 Blob，路径仍可走通。
 *
 * Wave20 S 路：补 OPFS 不可用端到端降级的单测加固——
 *  - OpfsUnavailableError 专用错误类型 → dataURL；
 *  - 降级路径不把 OPFS 专用 64-hex ref 泄漏进文档 JSON；
 *  - 坏 blob / 非图片 mime 不炸。
 */

function deps(over: Partial<ImageIngestDeps> = {}): ImageIngestDeps {
  return {
    putImageAsset: vi.fn(async () => ({ assetRef: 'asset_x' })),
    addImageBlock: vi.fn(() => 'block_1'),
    ...over,
  };
}

const png = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

/** 64 位小写 hex = OPFS 内容寻址 ref 形状。 */
const OPFS_REF_SHAPE = /^[0-9a-f]{64}$/;

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

  it('Wave20: OpfsUnavailableError（非安全上下文）→ dataURL，不泄漏 OPFS ref', async () => {
    const put = vi.fn(async () => {
      throw new OpfsUnavailableError();
    });
    const add = vi.fn((_src: string, _x: number, _y: number) => 'block_w20');
    const r = await ingestImageFile(deps({ putImageAsset: put, addImageBlock: add }), png(), 5, 5);
    expect(r.via).toBe('dataurl');
    expect(r.src.startsWith('data:')).toBe(true);
    // 关键断言：降级路径绝不把 OPFS 专用 64-hex ref 写进文档 JSON。
    expect(r.src).not.toMatch(OPFS_REF_SHAPE);
    expect(r.blockId).toBe('block_w20');
    // addImageBlock 拿到的是 data: URL，不是空串/错误对象/assetRef。
    const arg = String(add.mock.calls[0]![0]);
    expect(arg.startsWith('data:')).toBe(true);
    expect(arg).not.toMatch(OPFS_REF_SHAPE);
  });

  it('Wave20: putImageAsset 返回伪 ref（看似 64-hex 但实际未落盘）仍走 OPFS 分支', async () => {
    // 正常 OPFS 路径：putImageAsset 返回 64-hex → via=opfs，src 即 ref。
    const realRef = 'a'.repeat(64);
    const add = vi.fn(() => 'block_ok');
    const r = await ingestImageFile(
      deps({ putImageAsset: vi.fn(async () => ({ assetRef: realRef })), addImageBlock: add }),
      png(),
      0,
      0,
    );
    expect(r.via).toBe('opfs');
    expect(r.src).toBe(realRef);
    expect(r.src).toMatch(OPFS_REF_SHAPE);
  });

  it('Wave20: 坏 blob（非图片 mime）不炸，仍产出 dataURL', async () => {
    const put = vi.fn(async () => {
      throw new OpfsUnavailableError();
    });
    const add = vi.fn(() => 'block_bad');
    // text/plain blob：compressImageBlob 原样返回，FileReader 仍可读成 data:。
    const txt = new Blob([new Uint8Array([1, 2, 3])], { type: 'text/plain' });
    const r = await ingestImageFile(deps({ putImageAsset: put, addImageBlock: add }), txt, 0, 0);
    expect(r.via).toBe('dataurl');
    expect(r.src.startsWith('data:')).toBe(true);
  });
});
