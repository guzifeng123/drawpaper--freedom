import { blobToDataUrl, compressImageBlob } from './opfs';

/**
 * image-pipeline.ts —— 三条图片入口（粘贴 / 拖入画布 / 斜杠菜单插入）共用的
 * 「压缩 → OPFS 落盘 → assetRef 登记 → 建块」统一管线。
 *
 * 形状约定（与附件块一致）：
 *  - Blob 经 canvas 降采样后写入 OPFS，doc JSON 的 image.src 只存 assetRef 引用 id；
 *  - OPFS 不可用（旧浏览器 / 非安全上下文）时降级为 data: URL 内联，不产生坏引用；
 *  - 附件块（非图片）既有管线保持不变。
 *
 * 本模块不直接 import store，仅依赖注入的 deps，便于在 jsdom 里对「降级分支」做单测。
 */

export type ImageIngestVia = 'opfs' | 'dataurl';

export interface ImageIngestResult {
  /** 新建图片块的 id。 */
  blockId: string;
  /** 实际写入 image.src 的值：assetRef（OPFS）或 data: URL（降级）。 */
  src: string;
  /** 走了哪条存储路径。 */
  via: ImageIngestVia;
}

/** 管线所需的最小接缝（由 EditorApi 适配层提供）。 */
export interface ImageIngestDeps {
  /** 写 Blob 到 OPFS 并登记 doc.assetRefs；OPFS 不可用返回空 assetRef。 */
  putImageAsset(blob: Blob): Promise<{ assetRef: string }>;
  /** 以给定 src（assetRef 或 data:URL）在 (x,y) 建图片块，返回块 id。 */
  addImageBlock(src: string, x: number, y: number): string;
}

/**
 * 统一图片摄入：压缩 → 尝试 OPFS → 失败降级 dataURL。
 * 任何一步 OPFS 失败都不得抛出到 UI：降级为内联 dataURL，保证图片一定可见。
 */
export async function ingestImageFile(
  deps: ImageIngestDeps,
  file: Blob,
  x: number,
  y: number,
): Promise<ImageIngestResult> {
  const compressed = await compressImageBlob(file);

  // 1) 尝试 OPFS（压缩后 Blob 落盘，src 只存引用 id）。
  try {
    const r = await deps.putImageAsset(compressed);
    if (r && r.assetRef) {
      const blockId = deps.addImageBlock(r.assetRef, x, y);
      return { blockId, src: r.assetRef, via: 'opfs' };
    }
  } catch {
    // 落盘失败 → 落到下面的 dataURL 降级分支。
  }

  // 2) 降级：data: URL 内联（OPFS 不可用 / 写入异常）。
  const dataUrl = await blobToDataUrl(compressed);
  const blockId = deps.addImageBlock(dataUrl, x, y);
  return { blockId, src: dataUrl, via: 'dataurl' };
}
