import { nanoid } from 'nanoid';

/**
 * OPFS（Origin Private File System）大附件读写。
 * 能力不足（旧浏览器 / 非安全上下文）时抛 OpfsUnavailableError，由上层降级。
 */

const ASSET_DIR = 'drawpaper-assets';

export class OpfsUnavailableError extends Error {
  constructor(message = 'OPFS is not available in this environment') {
    super(message);
    this.name = 'OpfsUnavailableError';
  }
}

async function getAssetsDir(): Promise<FileSystemDirectoryHandle> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.getDirectory !== 'function'
  ) {
    throw new OpfsUnavailableError();
  }
  const root = await navigator.storage.getDirectory();
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
