import { editorStore } from '@/store/editor-store';
import { pushToast } from '@/panels/lib/toast';
import { runSync, type SyncChannel } from './orchestrator';
import { FolderSyncChannel } from './fsachannel';
import { WebDavSyncChannel } from './webdavchannel';
import type { SyncDirectoryHandle } from './directory-handle';
import type { WebDavConfig } from './webdav';
import { useSyncUi } from './sync-ui-store';
import { resetSyncMeta } from './sync-db';
import type { SyncChannelType } from './sync-ui-store';

/**
 * 同步控制器（单例）：持有当前通道，负责启停、手动/自动同步、定时轮询。
 *
 * - 两通道互斥：startX 会先停掉旧通道。
 * - 零外网红线：未配置通道时不注册任何定时器、不发任何请求。
 * - FSA 文件夹：本地变更防抖自动导出 + 轮询 + visibilitychange 检测外部改动。
 * - WebDAV：默认仅手动「立即同步」；可选定时轮询（默认关、下限 5 分钟）。
 * - 凭据只存 localStorage（与 AI key 同级）。
 */

const CONFIG_KEY = 'drawpaper-sync:config';

interface PersistedConfig {
  channel: SyncChannelType;
  webdav?: WebDavConfig;
  /** 定时轮询间隔（ms）；0/未设=关闭。下限 5 分钟由 UI 强制。 */
  pollMs?: number;
}

const FOLDER_POLL_MS = 5000;
const AUTO_PUSH_DEBOUNCE_MS = 2000;
const MIN_WEBDAV_POLL_MS = 5 * 60 * 1000;

function loadConfig(): PersistedConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return JSON.parse(raw) as PersistedConfig;
  } catch {
    /* ignore */
  }
  return { channel: 'none' };
}

function saveConfig(c: PersistedConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

class SyncController {
  private channel: SyncChannel | null = null;
  private docUnsub: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private autoPushTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastDocJson = '';

  /** 当前是否已配置并启用通道。 */
  get active(): boolean {
    return this.channel !== null;
  }

  get channelType(): SyncChannelType {
    return this.channel?.type ?? 'none';
  }

  /** 恢复上次配置（App 启动调用）：文件夹句柄无法跨刷新恢复，需用户重选；WebDAV 可恢复。 */
  async restore(): Promise<void> {
    const cfg = loadConfig();
    useSyncUi.getState().setChannel(cfg.channel);
    if (cfg.channel === 'webdav' && cfg.webdav) {
      this.startWebdav(cfg.webdav, cfg.pollMs ?? 0);
    } else if (cfg.channel === 'folder') {
      // 句柄未恢复：停在「未选择目录」态，等用户在面板重选。
      useSyncUi.getState().setChannel('folder');
    } else {
      useSyncUi.getState().setChannel('none');
    }
  }

  /** 启动 FSA 文件夹通道（用户选完目录后）。 */
  startFolder(handle: SyncDirectoryHandle): void {
    this.teardownTimers();
    this.channel = new FolderSyncChannel(handle);
    useSyncUi.getState().setChannel('folder');
    useSyncUi.getState().setTargetLabel(this.channel.label());
    saveConfig({ channel: 'folder' });
    this.attachDocWatcher();
    // 文件夹轮询 + 可见性变化检测外部改动。
    this.pollTimer = setInterval(() => void this.safeRun('folder-poll'), FOLDER_POLL_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
    void this.safeRun('folder-initial');
  }

  /** 启动 WebDAV 通道。 */
  startWebdav(config: WebDavConfig, pollMs: number): void {
    this.teardownTimers();
    this.channel = new WebDavSyncChannel(config);
    useSyncUi.getState().setChannel('webdav');
    useSyncUi.getState().setTargetLabel(this.channel.label());
    saveConfig({ channel: 'webdav', webdav: config, pollMs });
    // WebDAV 不监听本地变更自动推；仅手动 + 可选定时。
    if (pollMs >= MIN_WEBDAV_POLL_MS) {
      this.pollTimer = setInterval(() => void this.safeRun('webdav-poll'), pollMs);
    }
  }

  /** 手动「立即同步」。 */
  async runNow(): Promise<void> {
    await this.safeRun('manual');
  }

  /** 停止同步 + 清除凭据与全部元数据。 */
  async stopAndClear(): Promise<void> {
    this.teardownTimers();
    this.channel = null;
    saveConfig({ channel: 'none' });
    await resetSyncMeta();
    useSyncUi.getState().reset();
    pushToast('success', '已停止同步并清除凭据与同步记录');
  }

  // ---------------- 内部 ----------------

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') void this.safeRun('visibility');
  };

  private attachDocWatcher(): void {
    this.docUnsub?.();
    this.lastDocJson = JSON.stringify(editorStore.getState().doc);
    this.docUnsub = editorStore.subscribe((state, prev) => {
      if (state.doc === prev.doc) return;
      // 远端合并落库触发的 doc 变化不重复自动推（合成本轮已推过）。
      const json = JSON.stringify(state.doc);
      if (json === this.lastDocJson) return;
      this.lastDocJson = json;
      if (this.autoPushTimer) clearTimeout(this.autoPushTimer);
      this.autoPushTimer = setTimeout(() => void this.safeRun('auto-push'), AUTO_PUSH_DEBOUNCE_MS);
    });
  }

  private teardownTimers(): void {
    this.docUnsub?.();
    this.docUnsub = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.autoPushTimer) clearTimeout(this.autoPushTimer);
    this.autoPushTimer = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private async safeRun(reason: string): Promise<void> {
    if (!this.channel || this.running) return;
    this.running = true;
    try {
      const r = await runSync(this.channel);
      if (r.conflicts > 0) {
        pushToast('warn', `同步完成，发现 ${r.conflicts} 处冲突，已生成副本，顶部可查看`);
      } else if (r.push + r.merged > 0) {
        pushToast('success', `同步完成：推送 ${r.push}、拉取 ${r.merged} 个文档`);
      }
      void reason;
    } catch (e) {
      const kind = (e as { kind?: string }).kind;
      if (kind === 'auth') {
        pushToast('error', '认证失败，请检查用户名/密码');
        useSyncUi.getState().setError('认证失败，请检查用户名/密码');
      } else if (kind === 'network') {
        pushToast('error', '无法连接服务器');
        useSyncUi.getState().setError('无法连接服务器');
      } else {
        pushToast('error', `同步失败：${(e as Error).message}`);
        useSyncUi.getState().setError((e as Error).message);
      }
    } finally {
      this.running = false;
    }
  }

  /** 供 dev-hook 注入 fake handle（e2e）。 */
  __injectFakeForTest(handle: SyncDirectoryHandle): void {
    this.startFolder(handle);
  }

  /** 供 dev-hook：当前通道检视。 */
  inspect() {
    return {
      channel: this.channel?.type ?? ('none' as const),
      target: useSyncUi.getState().targetLabel,
      busy: useSyncUi.getState().busy,
      lastSyncAt: useSyncUi.getState().lastSyncAt,
      pushCount: useSyncUi.getState().pushCount,
      pullCount: useSyncUi.getState().pullCount,
      conflictCount: useSyncUi.getState().conflictCount,
      hasChannel: this.channel !== null,
    };
  }
}

export const syncController = new SyncController();
export { MIN_WEBDAV_POLL_MS };
