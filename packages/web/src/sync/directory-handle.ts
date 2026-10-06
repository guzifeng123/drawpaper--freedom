/**
 * 同步文件夹的最小目录抽象（Wave10 阶段 B）。
 *
 * 通道逻辑只依赖这个接口，不直接碰 FileSystemDirectoryHandle：
 *  - 生产：`createRealDirectoryHandle()` 包 `showDirectoryPicker`（Chromium）；
 *  - 测试：`createFakeDirectoryHandle()` 内存 Map，e2e 经 dev-hook 注入，
 *    走真实导出 / 外部改动检测 / 合并代码路径（Playwright 无法真实选目录）。
 *
 * 路径约定：POSIX 风格相对路径，`assets/<hash>` 放资产二进制。
 * 零网络 / 零新依赖。
 */

export interface SyncDirEntry {
  /** 相对路径（POSIX，含子目录前缀）。 */
  path: string;
  kind: 'file' | 'directory';
}

export interface SyncDirectoryHandle {
  /** 目录名（展示用）。 */
  readonly name: string;
  /** 递归列出全部文件（含 assets 子目录）。 */
  listFiles(): Promise<string[]>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, contents: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array | null>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

// ---------------- 内存 fake（测试 / 降级演示） ----------------

type FakeNode =
  | { kind: 'directory' }
  | { kind: 'file'; text?: string; bytes?: Uint8Array; modifiedAt: number };

/** 内存文件树 fake handle。外部改动直接经 `writeText/writeBytes` 模拟 Syncthing 落盘。 */
export class FakeDirectoryHandle implements SyncDirectoryHandle {
  readonly name: string;
  private tree = new Map<string, FakeNode>();

  constructor(name = 'fake-sync-folder') {
    this.name = name;
  }

  private normalize(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    for (const [p, node] of this.tree) {
      if (node.kind === 'file') out.push(p);
    }
    return out.sort();
  }

  async readText(path: string): Promise<string | null> {
    const node = this.tree.get(this.normalize(path));
    if (!node || node.kind !== 'file') return null;
    if (node.text !== undefined) return node.text;
    if (node.bytes) return new TextDecoder().decode(node.bytes);
    return null;
  }

  async writeText(path: string, contents: string): Promise<void> {
    this.tree.set(this.normalize(path), { kind: 'file', text: contents, modifiedAt: Date.now() });
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const node = this.tree.get(this.normalize(path));
    if (!node || node.kind !== 'file') return null;
    if (node.bytes) return node.bytes;
    if (node.text !== undefined) return new TextEncoder().encode(node.text);
    return null;
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.tree.set(this.normalize(path), { kind: 'file', bytes, modifiedAt: Date.now() });
  }

  async remove(path: string): Promise<void> {
    this.tree.delete(this.normalize(path));
  }

  /** 直接看内部树（e2e 断言 conflicted 副本是否生成）。 */
  dump(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [p, node] of this.tree) {
      if (node.kind !== 'file') continue;
      out[p] = node.text ?? (node.bytes ? `[bytes:${node.bytes.length}]` : '');
    }
    return out;
  }
}

// ---------------- 真实 FSA handle（Chromium） ----------------

interface FsaWindow {
  showDirectoryPicker?: (opts?: unknown) => Promise<FileSystemDirectoryHandle>;
}

/** 浏览器是否支持 showDirectoryPicker。 */
export function isFsaDirectorySupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as FsaWindow).showDirectoryPicker === 'function';
}

/** 弹目录选择器；用户取消返回 null。 */
export async function pickRealDirectory(): Promise<SyncDirectoryHandle | null> {
  if (!isFsaDirectorySupported()) return null;
  const w = window as unknown as FsaWindow;
  try {
    const dir = await w.showDirectoryPicker!({ mode: 'readwrite' });
    return new RealDirectoryHandle(dir);
  } catch {
    return null;
  }
}

/** 包真实 FileSystemDirectoryHandle。 */
class RealDirectoryHandle implements SyncDirectoryHandle {
  readonly name: string;
  constructor(private dir: FileSystemDirectoryHandle) {
    this.name = dir.name;
  }

  private async getFile(path: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const parts = path.split('/').filter(Boolean);
    let dir = this.dir;
    for (let i = 0; i < parts.length - 1; i += 1) {
      dir = await dir.getDirectoryHandle(parts[i]!, { create });
    }
    const last = parts[parts.length - 1];
    if (!last) return null;
    return dir.getFileHandle(last, { create });
  }

  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      // @ts-expect-error values() 迭代器在 TS lib 里可能缺
      for await (const entry of dir.values()) {
        const p = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.kind === 'directory') await walk(entry, p);
        else out.push(p);
      }
    };
    await walk(this.dir, '');
    return out.sort();
  }

  async readText(path: string): Promise<string | null> {
    try {
      const fh = await this.getFile(this.normalize(path), false);
      if (!fh) return null;
      const file = await fh.getFile();
      return await file.text();
    } catch {
      return null;
    }
  }

  async writeText(path: string, contents: string): Promise<void> {
    const fh = await this.getFile(this.normalize(path), true);
    if (!fh) return;
    const writable = await fh.createWritable();
    await writable.write(contents);
    await writable.close();
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    try {
      const fh = await this.getFile(this.normalize(path), false);
      if (!fh) return null;
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const fh = await this.getFile(this.normalize(path), true);
    if (!fh) return;
    const writable = await fh.createWritable();
    await writable.write(bytes);
    await writable.close();
  }

  async remove(path: string): Promise<void> {
    const parts = this.normalize(path).split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) return;
    let dir = this.dir;
    for (const p of parts) {
      try {
        dir = await dir.getDirectoryHandle(p);
      } catch {
        return;
      }
    }
    await dir.removeEntry(name).catch(() => undefined);
  }

  private normalize(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\/+/, '');
  }
}
