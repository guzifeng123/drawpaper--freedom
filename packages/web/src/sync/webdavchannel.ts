import type { SyncChannel } from './orchestrator';
import { WebDavClient, type WebDavConfig } from './webdav';

/**
 * WebDAV 通道：手写 WebDavClient 适配成 SyncChannel。
 * 路径布局：根目录放 `<docId>.kbnote`，资产放 `assets/<assetRef>`。
 * 凭据只在构造时从 localStorage 注入，本类不持久化。
 */
export class WebDavSyncChannel implements SyncChannel {
  readonly type = 'webdav' as const;
  private client: WebDavClient;

  constructor(private config: WebDavConfig) {
    this.client = new WebDavClient(config);
  }

  label(): string {
    try {
      const u = new URL(this.config.baseUrl);
      return `WebDAV：${u.host}`;
    } catch {
      return 'WebDAV';
    }
  }

  async listRemoteDocs(): Promise<string[]> {
    const all = await this.client.list();
    return all.filter((f) => f.endsWith('.kbnote') && !f.includes('conflicted-') && !f.startsWith('assets/'));
  }

  async pullDoc(docId: string): Promise<string | null> {
    return this.client.getText(`${docId}.kbnote`);
  }

  async pushDoc(docId: string, contents: string): Promise<void> {
    await this.client.putText(`${docId}.kbnote`, contents);
  }

  async pullAsset(ref: string): Promise<Uint8Array | null> {
    return this.client.getBytes(`assets/${ref}`);
  }

  async pushAsset(ref: string, bytes: Uint8Array): Promise<void> {
    await this.client.putBytes(`assets/${ref}`, bytes);
  }

  async writeConfcted(filename: string, contents: string): Promise<void> {
    await this.client.putText(filename, contents);
  }
}
