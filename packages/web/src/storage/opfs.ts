/**
 * OPFS（Origin Private File System）大附件读写 + 图片压缩 + objectURL 缓存。
 * 能力不足（旧浏览器 / 非安全上下文）时抛 OpfsUnavailableError，由上层降级为 dataURL 内嵌。
 *
 * Wave16 F 路：内容寻址（content-addressed）。写入时按字节算 SHA-256，文件名即 hash。
 * 相同内容只存一份 blob；跨文档引用同一内容时 ref 相同（dedup）。
 * 旧版 nanoid ref 的一次性重命名迁移在 asset-reconcile.ts 完成（这里只认形状）。
 */

const ASSET_DIR = 'drawpaper-assets';
/** 保留区（孤儿资产回收站）：`.trash/assets/<ref>` + 同名 meta 边车文件。 */
const TRASH_DIR = '.trash';
const TRASH_ASSETS_SUBDIR = 'assets';

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

/** 取保留区目录（assets/.trash/assets/），按需创建。 */
async function getTrashDir(): Promise<FileSystemDirectoryHandle> {
  const assets = await getAssetsDir();
  const trash = await assets.getDirectoryHandle(TRASH_DIR, { create: true });
  return trash.getDirectoryHandle(TRASH_ASSETS_SUBDIR, { create: true });
}

/** Blob → Uint8Array。 */
export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 计算字节的 SHA-256 十六进制摘要（Web Crypto subtle.digest）。
 * 返回 64 位小写 hex，作为内容寻址 ref。core 只把 hash 当不透明字符串。
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 文件是否已存在（不读内容）。 */
async function fileExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * 写入 Blob，返回 assetRef（= 内容 SHA-256 hex）。
 * 内容寻址：相同字节只写一次——同名 hash 已存在则跳过写入（幂等）。
 */
export async function putAsset(blob: Blob): Promise<{ assetRef: string }> {
  const bytes = await blobBytes(blob);
  const ref = await sha256Hex(bytes);
  const dir = await getAssetsDir();
  // 同名已存在 = 同内容已存，跳过（content-addressed dedup）。
  if (!(await fileExists(dir, ref))) {
    const fh = await dir.getFileHandle(ref, { create: true });
    const writable = await fh.createWritable();
    await writable.write(bytes);
    await writable.close();
  }
  return { assetRef: ref };
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

/** 物理删除附件；不存在静默忽略。 */
export async function deleteAsset(assetRef: string): Promise<void> {
  try {
    const dir = await getAssetsDir();
    await dir.removeEntry(assetRef);
  } catch {
    /* 已删除或不存在 */
  }
}

/** 某 blob 是否存在于主资产区。 */
export async function hasAsset(assetRef: string): Promise<boolean> {
  const dir = await getAssetsDir();
  return fileExists(dir, assetRef);
}

/** 列目录下全部条目名（不递归）。TS lib 缺 values() 迭代器，按仓库既有模式兜底。 */
async function listDirNames(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const out: string[] = [];
  // @ts-expect-error values() 迭代器在 TS lib 里可能缺
  for await (const entry of dir.values()) {
    out.push((entry as FileSystemHandle).name);
  }
  return out;
}

/** 列出现存全部资产 ref（主资产区，不含保留区）。 */
export async function listAssets(): Promise<string[]> {
  const dir = await getAssetsDir();
  const names = await listDirNames(dir);
  return names.filter((n) => n !== TRASH_DIR);
}

/**
 * 按【指定】assetRef 写回字节（同步导入回填 / reconcile 重命名用）。
 * 与 putAsset（内容寻址）不同：跨设备同步时文档 assetRefs 里登记的就是原 ref，
 * 必须按同名落盘，否则画布引用指向不存在的对象。已存在同名则覆盖（幂等）。
 */
export async function writeAssetToRef(assetRef: string, bytes: Uint8Array): Promise<void> {
  const dir = await getAssetsDir();
  const fh = await dir.getFileHandle(assetRef, { create: true });
  const writable = await fh.createWritable();
  await writable.write(bytes);
  await writable.close();
}

// ============ 保留区（孤儿资产回收站）============

/** 保留区条目元数据（边车 JSON）。 */
export interface TrashAssetMeta {
  ref: string;
  movedAt: number;
  sourceDocId: string;
}

/** 把孤儿资产从主资产区移入保留区（可恢复；不物理删除）。 */
export async function moveAssetToTrash(ref: string, meta: Omit<TrashAssetMeta, 'ref'>): Promise<void> {
  const srcDir = await getAssetsDir();
  const trash = await getTrashDir();
  try {
    const fh = await srcDir.getFileHandle(ref);
    const blob = await fh.getFile();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await writeAssetToRefInDir(trash, ref, bytes);
    const metaText = JSON.stringify({ ref, ...meta } satisfies TrashAssetMeta);
    await writeAssetToRefInDir(trash, `${ref}.meta.json`, new TextEncoder().encode(metaText));
    await srcDir.removeEntry(ref);
  } catch {
    /* 源不存在或已移走：幂等忽略 */
  }
}

async function writeAssetToRefInDir(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(bytes);
  await writable.close();
}

/** 列出保留区里的资产 ref（不含 .meta.json 边车）。 */
export async function listTrashAssets(): Promise<string[]> {
  const trash = await getTrashDir();
  const names = await listDirNames(trash);
  return names.filter((n) => !n.endsWith('.meta.json'));
}

/** 保留区占用总字节（人类可读体积由调用方格式化）。 */
export async function trashAssetsSize(): Promise<number> {
  const trash = await getTrashDir();
  let total = 0;
  for (const name of await listDirNames(trash)) {
    if (name.endsWith('.meta.json')) continue;
    try {
      const fh = await trash.getFileHandle(name);
      const blob = await fh.getFile();
      total += blob.size;
    } catch { /* ignore */ }
  }
  return total;
}

/** 物理清空保留区（用户确认后的最终删除，不可恢复）。 */
export async function emptyTrashAssets(): Promise<number> {
  const trash = await getTrashDir();
  let removed = 0;
  for (const name of await listDirNames(trash)) {
    try {
      await trash.removeEntry(name);
      removed += 1;
    } catch { /* ignore */ }
  }
  return removed;
}

/** 保留区某 ref 的元数据（供 e2e/检视）；无则 null。 */
export async function trashAssetMeta(ref: string): Promise<TrashAssetMeta | null> {
  const trash = await getTrashDir();
  try {
    const fh = await trash.getFileHandle(`${ref}.meta.json`);
    const blob = await fh.getFile();
    return JSON.parse(await blob.text()) as TrashAssetMeta;
  } catch {
    return null;
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
