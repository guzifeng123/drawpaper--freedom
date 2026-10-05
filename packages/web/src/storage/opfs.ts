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

/** 可选的重编码输出格式（SVG 不重编码，原样落盘）。 */
export type ImageOutputMime = 'image/png' | 'image/webp' | 'image/svg+xml';

/**
 * 纯决策：按输入 mime 决定压缩后的输出格式（无 DOM/canvas 依赖，可单测）。
 * 规则（详见 docs/wave7/image-opfs.md「格式选择矩阵」）：
 * - `image/svg+xml`：矢量，绝不经 canvas 栅格化（会丢文字/路径），原样落盘。
 * - `image/png`：保留 PNG（无损、原生带 alpha 透明），仍按长边降采样像素网格。
 * - 其余（jpg/gif/bmp/webp…）：统一转 webp q≈0.8，体积最优。
 */
export function selectOutputMime(inputMime: string): ImageOutputMime {
  const mime = (inputMime || '').toLowerCase();
  if (mime === 'image/svg+xml') return 'image/svg+xml';
  if (mime === 'image/png') return 'image/png';
  return IMAGE_OUTPUT_TYPE;
}

/** 判断 image.src 是否为 OPFS assetRef（相对）引用，而非内联 data:/blob: URL。 */
export function isAssetRefSrc(src: string | undefined | null): boolean {
  return !!src && !src.startsWith('data:') && !src.startsWith('blob:') && !src.startsWith('http');
}

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
 * 压缩图片 Blob：canvas 解码 → 长边 >1600 等比缩放 → 按 selectOutputMime 重编码。
 * SVG 矢量原样返回（不栅格化）；非图片或压缩失败时原样返回。
 */
export async function compressImageBlob(blob: Blob): Promise<Blob> {
  if (!blob.type.startsWith('image/')) return blob;
  const outMime = selectOutputMime(blob.type);
  // 矢量 SVG：不经 canvas，原样落 OPFS（保持可缩放/可导出矢量）。
  if (outMime === 'image/svg+xml') return blob;
  try {
    const { source, width: srcW, height: srcH } = await decodeImage(blob);
    const target = computeResize(IMAGE_MAX_LONG_EDGE, srcW, srcH) ?? { width: srcW, height: srcH };

    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    // PNG 可能带透明底：清透明，避免不透明黑底污染。
    if (outMime === 'image/png') ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, target.width, target.height);

    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, outMime, outMime === 'image/webp' ? IMAGE_OUTPUT_QUALITY : undefined),
    );
    return out ?? blob;
  } catch {
    return blob;
  }
}

/** Blob → data: URL（OPFS 不可用时的内联降级 / SVG 导出内嵌用）。 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 按文件头魔数嗅探图片真实 mime。
 * 背景：OPFS 的 FileSystemFileHandle.getFile() 不保留写入时 blob.type
 * （文件名是无扩展名的 nanoid），读回后 type='' → data: 落成 octet-stream，
 * 导致 SVG <image href="data:..."> 不按图片解码。这里按字节头修正。
 */
export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes[0] === 0x3c) return 'image/svg+xml'; // '<' (<?xml / <svg)
  return 'application/octet-stream';
}

/**
 * 把某 assetRef 的 Blob 读成自包含 data: URI（SVG 矢量导出内嵌用）。
 * 引用不存在返回 null。读回的 blob.type 不可靠，按魔数修正图片 mime。
 */
export async function assetRefToDataUri(assetRef: string): Promise<string | null> {
  const blob = await getAsset(assetRef);
  if (!blob) return null;
  const buf = new Uint8Array(await blob.arrayBuffer());
  const mime = sniffImageMime(buf);
  let binary = '';
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i] ?? 0);
  return `data:${mime};base64,${btoa(binary)}`;
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
