import type { SyncChannel } from './orchestrator';
import type { SyncDirectoryHandle } from './directory-handle';

/**
 * FSA 同步文件夹通道：把 SyncDirectoryHandle 适配成 SyncChannel。
 * 文件命名：`<docId>.kbnote`；资产放 `assets/<assetRef>`；
 * conflicted 副本由 orchestrator 按标题+时间戳命名。
 */
export class FolderSyncChannel implements SyncChannel {
  readonly type = 'folder' as const;
  /** FSA 文件夹通道不接端到端加密（见 docs/wave11/e2ee.md 威胁模型）。 */
  readonly e2eeActive = false as const;

  constructor(private dir: SyncDirectoryHandle) {}

  label(): string {
    return `同步文件夹：${this.dir.name}`;
  }

  async listRemoteDocs(): Promise<string[]> {
    const files = await this.dir.listFiles();
    return files.filter((f) => f.endsWith('.kbnote') && !f.includes('conflicted-'));
  }

  async listRemoteAssets(): Promise<string[]> {
    const files = await this.dir.listFiles();
    return files.filter((f) => f.startsWith('assets/')).map((f) => f.slice('assets/'.length));
  }

  async pullDoc(docId: string): Promise<string | null> {
    return this.dir.readText(`${docId}.kbnote`);
  }

  async pushDoc(docId: string, contents: string): Promise<void> {
    await this.dir.writeText(`${docId}.kbnote`, contents);
  }

  async pullAsset(ref: string): Promise<Uint8Array | null> {
    return this.dir.readBytes(`assets/${ref}`);
  }

  async pushAsset(ref: string, bytes: Uint8Array): Promise<void> {
    await this.dir.writeBytes(`assets/${ref}`, bytes);
  }

  async writeConfcted(filename: string, contents: string): Promise<void> {
    await this.dir.writeText(filename, contents);
  }
}
