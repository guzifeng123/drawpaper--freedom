import Dexie, { type Table } from 'dexie';
import type { FsaCapability } from '@drawpaper/core';

/**
 * File System Access 活动文件句柄管理。
 *  - pickLocalFile：弹打开框选 .kbnote（句柄持久化到 Dexie，刷新后可恢复）。
 *  - writeActiveFile：500ms 防抖写当前句柄（有活动句柄才写，否则 false）。
 *  - saveFileAs：另存为 .kbnote 并把句柄设为活动句柄。
 * 不支持 File System Access 的浏览器整组能力在 isSupported() 报 false，
 * 由 web-host 层走 <input type=file> / <a download> 降级。
 */

interface FsaWindow {
  showOpenFilePicker?: (opts?: unknown) => Promise<Array<{ getFile: () => Promise<File> } & FileSystemFileHandleLike>>;
  showSaveFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandleLike>;
}

interface FileSystemFileHandleLike {
  name?: string;
  createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
  queryPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<string>;
  requestPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<string>;
}

const KBNOTE_TYPES = {
  description: 'drawpaper 笔记',
  accept: { 'application/json': ['.kbnote'] },
} as const;

/** 单独的小库持久化活动句柄（FileSystemHandle 可结构化克隆进 IndexedDB）。 */
class FsaDB extends Dexie {
  active!: Table<{ id: string; handle: FileSystemFileHandleLike }, string>;
  constructor() {
    super('drawpaper-fsa');
    this.version(1).stores({ active: 'id' });
  }
}
const fsaDb = new FsaDB();

/** 活动文件管理器：实现 core 的 FsaCapability 接口。 */
export class ActiveFileManager implements FsaCapability {
  private activeHandle: FileSystemFileHandleLike | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingText: string | null = null;
  private pendingResolve: ((ok: boolean) => void) | null = null;
  /** v1→v2 升级确认门控：true 时暂停对活动文件的写盘（Dexie 自动保存不受影响）。 */
  private writesBlocked = false;

  /** 升级门控：blocked=true 时 writeActiveFile 暂停写盘，直到用户确认。 */
  setWritesBlocked(blocked: boolean): void {
    this.writesBlocked = blocked;
    if (blocked && this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
  }

  isWritesBlocked(): boolean {
    return this.writesBlocked;
  }

  isSupported(): boolean {
    if (typeof window === 'undefined') return false;
    const w = window as unknown as FsaWindow;
    return typeof w.showOpenFilePicker === 'function' && typeof w.showSaveFilePicker === 'function';
  }

  async pickLocalFile(): Promise<{ name: string; text: string } | null> {
    if (!this.isSupported()) return null;
    try {
      const w = window as unknown as FsaWindow;
      const [handle] = await w.showOpenFilePicker!({ types: [KBNOTE_TYPES], excludeAcceptAllOption: true, multiple: false });
      if (!handle) return null;
      const file = await handle.getFile();
      const text = await file.text();
      await this.setActive(handle);
      return { name: file.name, text };
    } catch {
      return null;
    }
  }

  writeActiveFile(text: string): Promise<boolean> {
    if (this.writesBlocked) return Promise.resolve(false);
    if (!this.activeHandle) return Promise.resolve(false);
    this.pendingText = text;
    if (this.writeTimer !== undefined) clearTimeout(this.writeTimer);
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.writeTimer = setTimeout(async () => {
        const t = this.pendingText;
        this.pendingText = null;
        let ok = false;
        if (t != null && this.activeHandle) {
          try {
            const writable = await this.activeHandle.createWritable();
            await writable.write(t);
            await writable.close();
            ok = true;
          } catch {
            ok = false;
          }
        }
        this.pendingResolve?.(ok);
        this.pendingResolve = null;
      }, 500);
    });
  }

  async saveFileAs(suggestedName: string, text: string): Promise<string | null> {
    if (!this.isSupported()) return null;
    try {
      const w = window as unknown as FsaWindow;
      const handle = await w.showSaveFilePicker!({ suggestedName, types: [KBNOTE_TYPES] });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      await this.setActive(handle);
      return handle.name ?? suggestedName;
    } catch {
      return null;
    }
  }

  /** 清除活动句柄（不落盘关系解除）。 */
  clear(): void {
    this.activeHandle = null;
    if (this.writeTimer !== undefined) clearTimeout(this.writeTimer);
  }

  /**
   * 刷新后恢复上次活动句柄（需用户重新授权 readwrite）。
   * 成功返回文件名，失败/未授权返回 null。
   */
  async restoreActiveFile(): Promise<string | null> {
    if (!this.isSupported()) return null;
    try {
      const row = await fsaDb.active.get('current');
      if (!row) return null;
      const handle = row.handle;
      const perm =
        (await handle.requestPermission?.({ mode: 'readwrite' })) ??
        (await handle.queryPermission?.({ mode: 'readwrite' }));
      if (perm !== 'granted') return null;
      this.activeHandle = handle;
      return handle.name ?? null;
    } catch {
      return null;
    }
  }

  private async setActive(handle: FileSystemFileHandleLike): Promise<void> {
    this.activeHandle = handle;
    try {
      await fsaDb.active.put({ id: 'current', handle });
    } catch {
      /* 持久化失败不影响当前会话 */
    }
  }
}

/** 单例。 */
export const activeFileManager = new ActiveFileManager();

// ============ 一次性打开/保存（web-host 降级流，不绑定活动句柄）============

/** 能力检测别名。 */
export function isFsaSupported(): boolean {
  return activeFileManager.isSupported();
}

/** 一次性打开 .kbnote（不把句柄设为活动句柄）；不支持或取消返回 null。 */
export async function openWithFsa(): Promise<{ name: string; text: string } | null> {
  if (!activeFileManager.isSupported()) return null;
  const w = window as unknown as FsaWindow;
  try {
    const [handle] = await w.showOpenFilePicker!({ types: [KBNOTE_TYPES], excludeAcceptAllOption: true, multiple: false });
    if (!handle) return null;
    const file = await handle.getFile();
    return { name: file.name, text: await file.text() };
  } catch {
    return null;
  }
}

/** 一次性另存 .kbnote；不支持或取消返回 false（由 host 走下载降级）。 */
export async function saveWithFsa(filename: string, text: string): Promise<boolean> {
  if (!activeFileManager.isSupported()) return false;
  const w = window as unknown as FsaWindow;
  try {
    const handle = await w.showSaveFilePicker!({ suggestedName: filename, types: [KBNOTE_TYPES] });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}
