import { nanoid } from 'nanoid';

/**
 * OPFS（Origin Private File System）大附件读写 + 图片压缩 + objectURL 缓存。
 * 能力不足（旧浏览器 / 非安全上下文）时抛 OpfsUnavailableError，由上层降级为 dataURL 内嵌。
 */

const ASSET_DIR = 'drawpaper-assets';

/** 图片长边上限：超过则等比缩到此值。 */
export const IMAGE_MAX_LONG_EDGE = 1600;
/** 导出 mime 与质量。 */
export const IMAGE_OUTPUT_TYPE = 'image/webp';
export const IMAGE_OUTPUT_QUALITY = 0.8;

export class OpfsUnavailableError extends Error {
  constructor(message = 'OPFS is not available in this environment') {
    super(message);
    this.name = 'OpfsUnavailableError';
  }
}

/** 能力检测：OPFS 是否可用。 */
export function isOpfsAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === 'function'
  );
}

async function getAssetsDir(): Promise<FileSystemDirectoryHandle> {
  if (!isOpfsAvailable()) throw new OpfsUnavailableError();
  const root = await navigator.storage!.getDirectory();
  return root.getDirectoryHandle(ASSET_DIR, { create: true });
}

/** 写入 Blob，返回 assetRef（文件名 id）。 */
export async function putAsset(blob: Blob): Promise<{ assetRef: string }> {
  const dir = await getAssetsDir();
  const assetRef = nanoid();
  const fh = await dir.getFileHandle(assetRef, { create: true });
  const writable = await fh.createWritable();
  await writable.write(blob);
  await writable.close();
  return { assetRef };
}

/** 读取 Blob；不存在返回 null。 */
export async function getAsset(assetRef: string): Promise<Blob | null> {
  try {
    const dir = await getAssetsDir();
    const fh = await dir.getFileHandle(assetRef);
    return await fh.getFile();
  } catch {
    return null;
  }
}

/** 删除附件；不存在静默忽略。 */
export async function deleteAsset(assetRef: string): Promise<void> {
  try {
    const dir = await getAssetsDir();
    await dir.removeEntry(assetRef);
  } catch {
    /* 已删除或不存在 */
  }
}

// ============ 图片压缩 ============

/**
 * 纯函数：给定原始宽高与长边上限，返回压缩后的目标宽高；
 * 无需缩放时返回 null。抽出便于在 jsdom 里单测尺寸决策（不依赖 canvas）。
 */
export function computeResize(
  targetLongEdge: number,
  srcW: number,
  srcH: number,
): { width: number; height: number } | null {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) return null;
  const longEdge = Math.max(srcW, srcH);
  if (longEdge <= targetLongEdge) return null;
  const scale = targetLongEdge / longEdge;
  return {
    width: Math.round(srcW * scale),
    height: Math.round(srcH * scale),
  };
}

/**
 * 压缩图片 Blob：canvas 解码 → 长边 >1600 等比缩放 → 导出 webp/jpeg q≈0.8。
 * 非图片或压缩失败时原样返回。
 */
export async function compressImageBlob(blob: Blob): Promise<Blob> {
  if (!blob.type.startsWith('image/')) return blob;
  try {
    const { source, width: srcW, height: srcH } = await decodeImage(blob);
    const target = computeResize(IMAGE_MAX_LONG_EDGE, srcW, srcH) ?? { width: srcW, height: srcH };

    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    ctx.drawImage(source, 0, 0, target.width, target.height);

    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, IMAGE_OUTPUT_TYPE, IMAGE_OUTPUT_QUALITY),
    );
    return out ?? blob;
  } catch {
    return blob;
  }
}

/** 解码图片，返回可绘制源与自然尺寸（优先 createImageBitmap，回退 Image）。 */
function decodeImage(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob).then((bmp) => ({
      source: bmp,
      width: bmp.width,
      height: bmp.height,
    }));
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image decode failed'));
    };
    img.src = url;
  });
}

// ============ objectURL 缓存（assetRef → 可渲染 URL）============

const urlCache = new Map<string, string>();

/** 取附件的 objectURL（缓存；同一 ref 复用，避免重复解码）。 */
export async function getAssetUrl(assetRef: string): Promise<string | null> {
  const cached = urlCache.get(assetRef);
  if (cached) return cached;
  const blob = await getAsset(assetRef);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(assetRef, url);
  return url;
}

/** 回收某附件的 objectURL。 */
export function revokeAssetUrl(assetRef: string): void {
  const url = urlCache.get(assetRef);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(assetRef);
  }
}
