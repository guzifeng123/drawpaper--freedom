import { editorStore } from '@/store/editor-store';
import { pushToast } from '@/panels/lib/toast';
import { runSync, type SyncChannel, type SyncRunResult } from './orchestrator';
import { FolderSyncChannel } from './fsachannel';
import { WebDavSyncChannel } from './webdavchannel';
import type { SyncDirectoryHandle } from './directory-handle';
import type { WebDavConfig } from './webdav';
import { useSyncUi } from './sync-ui-store';
import { resetSyncMeta, clearSyncBase } from './sync-db';
import { E2eeError } from './crypto';
import type { SyncChannelType } from './sync-ui-store';

/**
 * 同步控制器（单例）：持有当前通道，负责启停、手动/自动同步、定时轮询。
 *
 * - 两通道互斥：startX 会先停掉旧通道。
 * - 零外网红线：未配置通道时不注册任何定时器、不发任何请求。
 * - FSA 文件夹：本地变更防抖自动导出 + 轮询 + visibilitychange 检测外部改动。
 * - WebDAV：默认仅手动「立即同步」；可选定时轮询（默认关、下限 5 分钟）。
 * - 凭据只存 localStorage（与 AI key 同级）。
 *
 * Wave11 端到端加密（仅 WebDAV，可选，默认关）：
 *  - 开关 + 「记住本次会话」存 localStorage；口令本身【绝不】写 localStorage。
 *  - 口令仅内存保存；勾选「记住本次会话」才镜像到 sessionStorage（标签页存活期）。
 *  - 刷新后若开启加密但内存/会话都没有口令 → 不建通道、零网络，面板弹解锁框。
 *  - 错误口令（GCM 认证失败）：明确 toast，本轮 abort，不覆盖本地、不写坏远端。
 *  - 换口令：清 base → 下一轮全量重推新口令信封（旧信封本端已无法解，见 e2ee.md）。
 */

const CONFIG_KEY = 'drawpaper-sync:config';
const SESSION_PASS_KEY = 'drawpaper-sync:e2ee-pass';

interface E2eePersisted {
  /** 是否开启端到端加密（用户主动开关，默认 false）。 */
  enabled: boolean;
  /** 是否把口令镜像到 sessionStorage（仅本标签页存活期；默认 false）。 */
  rememberSession: boolean;
}

interface PersistedConfig {
  channel: SyncChannelType;
  webdav?: WebDavConfig;
  /** 定时轮询间隔（ms）；0/未设=关闭。下限 5 分钟由 UI 强制。 */
  pollMs?: number;
  e2ee?: E2eePersisted;
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

function rememberSessionPass(pass: string | null, remember: boolean): void {
  try {
    if (pass && remember) sessionStorage.setItem(SESSION_PASS_KEY, pass);
    else sessionStorage.removeItem(SESSION_PASS_KEY);
  } catch {
    /* sessionStorage 可能被禁用 */
  }
}

function readSessionPass(): string | null {
  try {
    return sessionStorage.getItem(SESSION_PASS_KEY);
  } catch {
    return null;
  }
}

class SyncController {
  private channel: SyncChannel | null = null;
  private docUnsub: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private autoPushTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastDocJson = '';
  /** 内存中的 E2EE 口令（刷新即失，不持久化）。 */
  private e2eePass: string | null = null;
  /** 最近一轮同步结果（e2e 检视资产推送计数用；非持久）。 */
  private lastRun: SyncRunResult | null = null;

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
      const e2ee = cfg.e2ee?.enabled ? cfg.e2ee : undefined;
      if (!e2ee) {
        this.startWebdav(cfg.webdav, cfg.pollMs ?? 0, { enabled: false });
        return;
      }
      // 加密已开：先尝试内存/会话口令；都没有则挂起等解锁，不发任何网络。
      this.e2eePass = this.e2eePass ?? readSessionPass();
      useSyncUi.getState().setE2eeEnabled(true);
      if (this.e2eePass) {
        this.startWebdav(cfg.webdav, cfg.pollMs ?? 0, {
          enabled: true,
          passphrase: this.e2eePass,
          rememberSession: e2ee.rememberSession,
        });
      } else {
        useSyncUi.getState().setTargetLabel(this.webdavHostLabel(cfg.webdav));
        useSyncUi.getState().setE2eeLocked(true);
      }
    } else if (cfg.channel === 'folder') {
      // 句柄未恢复：停在「未选择目录」态，等用户在面板重选。
      useSyncUi.getState().setChannel('folder');
    } else {
      useSyncUi.getState().setChannel('none');
    }
  }

  private webdavHostLabel(config: WebDavConfig): string {
    try {
      return `WebDAV：${new URL(config.baseUrl).host}（待解锁）`;
    } catch {
      return 'WebDAV（待解锁）';
    }
  }

  /** 启动 FSA 文件夹通道（用户选完目录后）。 */
  startFolder(handle: SyncDirectoryHandle): void {
    this.teardownTimers();
    this.channel = new FolderSyncChannel(handle);
    this.e2eePass = null;
    useSyncUi.getState().setChannel('folder');
    useSyncUi.getState().setTargetLabel(this.channel.label());
    useSyncUi.getState().setE2eeActive(false);
    useSyncUi.getState().setE2eeLocked(false);
    saveConfig({ channel: 'folder' });
    this.attachDocWatcher();
    // 文件夹轮询 + 可见性变化检测外部改动。
    this.pollTimer = setInterval(() => void this.safeRun('folder-poll'), FOLDER_POLL_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
    void this.safeRun('folder-initial');
  }

  /** 启动 WebDAV 通道。e2ee 缺省关闭（Wave10 明文）。 */
  startWebdav(
    config: WebDavConfig,
    pollMs: number,
    e2ee: { enabled: boolean; passphrase?: string; rememberSession?: boolean } = { enabled: false },
  ): void {
    this.teardownTimers();
    const pass = e2ee.enabled ? e2ee.passphrase ?? null : null;
    this.e2eePass = pass;
    if (e2ee.enabled) rememberSessionPass(pass, e2ee.rememberSession ?? false);
    else rememberSessionPass(null, false);
    this.channel = new WebDavSyncChannel(config, { passphrase: pass ?? undefined });
    useSyncUi.getState().setChannel('webdav');
    useSyncUi.getState().setTargetLabel(this.channel.label());
    useSyncUi.getState().setE2eeEnabled(!!e2ee.enabled);
    useSyncUi.getState().setE2eeActive(!!pass);
    useSyncUi.getState().setE2eeLocked(false);
    saveConfig({ channel: 'webdav', webdav: config, pollMs, e2ee: { enabled: !!e2ee.enabled, rememberSession: e2ee.rememberSession ?? false } });
    // WebDAV 不监听本地变更自动推；仅手动 + 可选定时。
    if (pollMs >= MIN_WEBDAV_POLL_MS) {
      this.pollTimer = setInterval(() => void this.safeRun('webdav-poll'), pollMs);
    }
  }

  /**
   * 刷新后输入口令解锁已配置的 WebDAV 加密通道。
   * 解锁后立即跑一轮；口令错则不建通道、不清本地数据。
   */
  async unlockWebdav(passphrase: string): Promise<void> {
    const cfg = loadConfig();
    if (cfg.channel !== 'webdav' || !cfg.webdav) throw new Error('尚未配置 WebDAV');
    this.e2eePass = passphrase;
    rememberSessionPass(passphrase, cfg.e2ee?.rememberSession ?? false);
    const channel = new WebDavSyncChannel(cfg.webdav, { passphrase });
    this.channel = channel;
    useSyncUi.getState().setChannel('webdav');
    useSyncUi.getState().setTargetLabel(channel.label());
    useSyncUi.getState().setE2eeActive(true);
    useSyncUi.getState().setE2eeLocked(false);
    try {
      await runSync(channel);
    } catch (e) {
      if (e instanceof E2eeError) {
        // 口令错：拆掉通道、清内存口令，保持锁定态；本地/远端都没动过（本轮在拉取阶段即失败）。
        this.channel = null;
        this.e2eePass = null;
        useSyncUi.getState().setE2eeActive(false);
        useSyncUi.getState().setE2eeLocked(true);
      }
      throw e;
    }
  }

  /**
   * 更换加密口令：重建通道 + 清 base → 下一轮把全部本地文档以新口令信封全量重推。
   * （旧口令信封本端已无法解，故视为全新起点；文档内容在各端本地库完好。）
   */
  async changeWebdavPassphrase(newPassphrase: string, rememberSession: boolean): Promise<void> {
    const cfg = loadConfig();
    if (cfg.channel !== 'webdav' || !cfg.webdav) throw new Error('尚未配置 WebDAV');
    this.e2eePass = newPassphrase;
    rememberSessionPass(newPassphrase, rememberSession);
    saveConfig({ channel: 'webdav', webdav: cfg.webdav, pollMs: cfg.pollMs ?? 0, e2ee: { enabled: true, rememberSession } });
    await clearSyncBase();
    const channel = new WebDavSyncChannel(cfg.webdav, { passphrase: newPassphrase });
    this.channel = channel;
    useSyncUi.getState().setTargetLabel(channel.label());
    useSyncUi.getState().setE2eeActive(true);
    await runSync(channel);
  }

  /** 手动「立即同步」。 */
  async runNow(): Promise<void> {
    await this.safeRun('manual');
  }

  /** 停止同步 + 清除凭据与全部元数据。 */
  async stopAndClear(): Promise<void> {
    this.teardownTimers();
    this.channel = null;
    this.e2eePass = null;
    rememberSessionPass(null, false);
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
      this.lastRun = r;
      if (r.conflicts > 0) {
        pushToast('warn', `同步完成，发现 ${r.conflicts} 处冲突，已生成副本，顶部可查看`);
      } else if (r.push + r.merged > 0 || r.assetsPushed > 0) {
        const parts = [`推送 ${r.push} 个文档`, `拉取/合并 ${r.merged} 个文档`];
        if (r.assetsPushed > 0) parts.push(`上传资产 ${r.assetsPushed}`);
        if (r.assetsFailed > 0) parts.push(`资产失败 ${r.assetsFailed}`);
        pushToast('success', `同步完成：${parts.join('、')}`);
      }
      void reason;
    } catch (e) {
      if (e instanceof E2eeError && e.kind === 'auth') {
        // 错误口令 / 密文被篡改：本轮在拉取阶段即失败，尚未写本地、也未推远端。
        this.channel = null;
        this.e2eePass = null;
        rememberSessionPass(null, false);
        useSyncUi.getState().setE2eeActive(false);
        useSyncUi.getState().setE2eeLocked(true);
        useSyncUi.getState().setError(e.message);
        pushToast('error', `端到端加密失败：${e.message}。本地与远端数据均未改动，请重新输入口令`);
      } else {
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
      e2eeActive: useSyncUi.getState().e2eeActive,
      e2eeLocked: useSyncUi.getState().e2eeLocked,
      /** 最近一轮同步结果（含资产推/失败计数）；未跑过为 null。 */
      lastRun: this.lastRun,
    };
  }
}

export const syncController = new SyncController();
export { MIN_WEBDAV_POLL_MS };
