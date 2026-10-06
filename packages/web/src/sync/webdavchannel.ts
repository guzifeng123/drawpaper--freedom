import type { SyncChannel } from './orchestrator';
import { WebDavClient, type WebDavConfig } from './webdav';
import { encryptBundle, decryptBundle, utf8Encode, utf8Decode } from './crypto';

/**
 * WebDAV 通道：手写 WebDavClient 适配成 SyncChannel。
 * 路径布局：根目录放 `<docId>.kbnote`，资产放 `assets/<assetRef>`。
 * 凭据只在构造时从 localStorage 注入，本类不持久化。
 *
 * Wave11 端到端加密（可选，默认关）：
 *  - 传入 passphrase 即开启：PUT 前把 .kbnote / conflicted 副本 / 资产包成信封，
 *    GET 后解开信封再交给上层；orchestrator / core 合并语义零改动。
 *  - 不传 passphrase 时，Wave10 明文路径逐字节行为不变。
 *  - FSA 通道不接加密（见 docs/wave11/e2ee.md 威胁模型）。
 */
export class WebDavSyncChannel implements SyncChannel {
  readonly type = 'webdav' as const;
  private client: WebDavClient;
  /** 开启端到端加密时的口令；null = 明文（Wave10 行为）。 */
  private passphrase: string | null;

  constructor(private config: WebDavConfig, options: { passphrase?: string } = {}) {
    this.client = new WebDavClient(config);
    this.passphrase = options.passphrase ?? null;
  }

  /** 当前通道是否处于端到端加密模式（设置面板 / e2e 检视用）。 */
  get e2eeActive(): boolean {
    return this.passphrase !== null;
  }

  label(): string {
    try {
      const u = new URL(this.config.baseUrl);
      return this.passphrase ? `WebDAV：${u.host}（端到端加密）` : `WebDAV：${u.host}`;
    } catch {
      return this.passphrase ? 'WebDAV（端到端加密）' : 'WebDAV';
    }
  }

  async listRemoteDocs(): Promise<string[]> {
    const all = await this.client.list();
    return all.filter((f) => f.endsWith('.kbnote') && !f.includes('conflicted-') && !f.startsWith('assets/'));
  }

  async pullDoc(docId: string): Promise<string | null> {
    const raw = await this.client.getBytes(`${docId}.kbnote`);
    if (raw == null) return null;
    if (!this.passphrase) return utf8Decode(raw);
    const plain = await decryptBundle(raw, this.passphrase);
    return utf8Decode(plain);
  }

  async pushDoc(docId: string, contents: string): Promise<void> {
    if (!this.passphrase) {
      await this.client.putText(`${docId}.kbnote`, contents);
      return;
    }
    const envelope = await encryptBundle(utf8Encode(contents), this.passphrase);
    // 信封即 JSON：仍按 octet-stream 上送，服务器只看到自描述信封字节。
    await this.client.putBytes(`${docId}.kbnote`, envelope);
  }

  async pullAsset(ref: string): Promise<Uint8Array | null> {
    const raw = await this.client.getBytes(`assets/${ref}`);
    if (raw == null) return null;
    if (!this.passphrase) return raw;
    return decryptBundle(raw, this.passphrase);
  }

  async pushAsset(ref: string, bytes: Uint8Array): Promise<void> {
    if (!this.passphrase) {
      await this.client.putBytes(`assets/${ref}`, bytes);
      return;
    }
    // 资产为不可变二进制、文件名随机 hash；加密模式下同样包成信封，服务器看不到图像字节。
    const envelope = await encryptBundle(bytes, this.passphrase);
    await this.client.putBytes(`assets/${ref}`, envelope);
  }

  async writeConfcted(filename: string, contents: string): Promise<void> {
    if (!this.passphrase) {
      await this.client.putText(filename, contents);
      return;
    }
    const envelope = await encryptBundle(utf8Encode(contents), this.passphrase);
    await this.client.putBytes(filename, envelope);
  }
}
