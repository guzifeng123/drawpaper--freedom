/**
 * File System Access API 能力检测与读写助手。
 * 不支持时返回 false/null，由 host 层走 <input type=file> / <a download> 降级。
 */

interface FsaWithTypes {
  showOpenFilePicker?: (opts?: unknown) => Promise<Array<{ getFile: () => Promise<File> }>>;
  showSaveFilePicker?: (opts?: unknown) => Promise<{
    createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
  }>;
}

export function isFsaSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as FsaWithTypes;
  return typeof w.showOpenFilePicker === 'function' && typeof w.showSaveFilePicker === 'function';
}

const KBNOTE_TYPES = {
  description: 'drawpaper 笔记',
  accept: { 'application/json': ['.kbnote'] },
} as const;

/** 打开 .kbnote；不支持或用户取消返回 null。 */
export async function openWithFsa(): Promise<{ name: string; text: string } | null> {
  if (!isFsaSupported()) return null;
  try {
    const w = window as unknown as FsaWithTypes;
    const [handle] = await w.showOpenFilePicker!({
      types: [KBNOTE_TYPES],
      excludeAcceptAllOption: true,
      multiple: false,
    });
    if (!handle) return null;
    const file = await handle.getFile();
    const text = await file.text();
    return { name: file.name, text };
  } catch {
    return null;
  }
}

/** 保存 .kbnote；不支持或用户取消返回 false（由 host 走下载降级）。 */
export async function saveWithFsa(filename: string, text: string): Promise<boolean> {
  if (!isFsaSupported()) return false;
  try {
    const w = window as unknown as FsaWithTypes;
    const handle = await w.showSaveFilePicker!({
      suggestedName: filename,
      types: [KBNOTE_TYPES],
    });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}
