import type { HostAdapter, OpenFileResult } from '@drawpaper/core';
import { WebHostAdapter } from './web-host';
import { blobToBase64 } from './blob-base64';

/**
 * Tauri 2 HostAdapter — desktop (Windows WebView2) implementation.
 *
 * 设计要点（见 docs/p2-shells.md）：
 *  - 本文件**不 import** `@tauri-apps/api`。web 包要保持零新增依赖、
 *    `pnpm -r build` 不受影响；Tauri 2 在开启 `withGlobalTauri`（默认）时
 *    会把 `__TAURI__` 全局对象注入 WebView，我们直接用 `window.__TAURI__`
 *    调用 invoke/event。后续若要换正式 SDK，只需把下面的 `tauriInvoke`
 *    函数换成 `import { invoke } from '@tauri-apps/api/core'`。
 *  - 运行时能力检测：`'__TAURI__' in window`。不在 Tauri 环境时工厂
 *    `createBestHostAdapter()` 会退化为 WebHostAdapter，本类方法防御性抛错。
 *  - 与 web-host.ts 同构：open/save/print/share 四个方法签名一致。
 */

/** Tauri 2 注入的最小全局形状（duck-type，不引 SDK）。 */
interface TauriGlobal {
  core?: {
    invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  };
  event?: {
    listen(event: string, handler: (e: { payload: unknown }) => void): Promise<() => void>;
    emit(event: string, payload?: unknown): Promise<void>;
  };
}

function tauriGlobal(): TauriGlobal | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return w && '__TAURI__' in w ? (w.__TAURI__ as TauriGlobal) : null;
}

/** 可识别的「不在 Tauri 环境」错误，工厂/集成层可用 err.name 判断降级。 */
export class TauriUnavailableError extends Error {
  override readonly name = 'TauriUnavailableError';
  constructor(msg = 'Tauri host APIs unavailable: not running inside the Tauri WebView') {
    super(msg);
  }
}

/** Rust `open_kbnote` 命令的返回形状（比 core.OpenFileResult 多一个绝对 path）。 */
interface OpenKbnoteReply {
  name: string;
  text: string;
  path: string;
}

/**
 * Wave13：最近文件菜单点击后 Rust 读盘并 emit 的富 `app:open-file` payload。
 *  - 最近文件子菜单：`{path, name, text, external:true}`（text 已由 Rust 读好）。
 *  - 双击关联 / 单实例转发（兼容路径）：仅 `{path, external:true}`，无 text。
 */
export interface OpenFilePayload {
  path: string;
  name?: string;
  text?: string;
  external?: boolean;
}

/** `save_export` 的四类导出类型（与 Rust 过滤器一一对应）。 */
export type ExportExt = 'pdf' | 'png' | 'svg' | 'md';

/** `save_export` 的联合返回值：cancelled 是正常 resolve，绝不弹错误。 */
export type ExportSaveOutcome =
  | { status: 'saved'; path: string }
  | { status: 'cancelled' };

export class TauriHostAdapter implements HostAdapter {
  private readonly tauri: TauriGlobal;

  constructor() {
    const t = tauriGlobal();
    if (!t || !t.core) throw new TauriUnavailableError();
    this.tauri = t;
  }

  /** 内部用：调 Rust command。把 Tauri 的 reject 统一成 Error。 */
  private invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.tauri.core) return Promise.reject(new TauriUnavailableError());
    return this.tauri.core.invoke<T>(cmd, args);
  }

  async showOpenFilePicker(): Promise<OpenFileResult | null> {
    // Rust 端：用户取消对话框返回 null；读盘失败 reject。
    const reply = await this.invoke<OpenKbnoteReply | null>('open_kbnote');
    if (!reply) return null;
    return { name: reply.name, text: reply.text };
  }

  async showSaveFilePicker(filename: string, text: string): Promise<void> {
    try {
      // force_pick=false：若 Rust 端已记住 current_path 则原地覆盖。
      await this.invoke<string>('save_kbnote', { filename, text, forcePick: false });
    } catch (err) {
      // Rust 端把「用户点了取消」作为 reject("cancelled") 抛出——
      // 与 web 侧 showSaveFilePicker 的取消语义对齐：静默吞掉。
      if (typeof err === 'string' && err === 'cancelled') return;
      throw err;
    }
  }

  /**
   * 打印。
   *
   * 说明：原生菜单的「打印」项由 Rust emit `app:menu{id:"export:print"}`，
   * 前端在集成期监听该事件后进入打印 CSS 态再调本方法。这里直接走
   * WebView2 自带的 `window.print()`（底层是系统打印对话框，可另存 PDF），
   * 不再走 Rust 命令——web 侧打印逻辑（A4 分页叠加、@page）完全复用。
   */
  print(): void {
    window.print();
  }

  /**
   * 分享。Tauri 桌面端当前没有系统分享面板；保留方法以满足 HostAdapter
   * 接口，桌面端默认 no-op。未来可接 `tauri-plugin-share` 或外部邮件/IM。
   */
  async share(): Promise<void> {
    // no-op on desktop
  }

  /**
   * 订阅原生菜单事件（集成期用）。把 `app:menu` 事件桥到回调。
   * 返回 unsubscribe 函数。
   */
  onMenuEvent(handler: (itemId: string) => void): Promise<() => void> {
    if (!this.tauri.event) return Promise.resolve(() => undefined);
    return this.tauri.event.listen('app:menu', (e) => {
      const payload = e.payload as { id?: string };
      if (payload && typeof payload.id === 'string') handler(payload.id);
    });
  }

  /** 订阅 `.kbnote` 双击/第二实例转发/最近文件菜单的打开文件事件。 */
  onOpenFileEvent(handler: (payload: OpenFilePayload) => void): Promise<() => void> {
    if (!this.tauri.event) return Promise.resolve(() => undefined);
    return this.tauri.event.listen('app:open-file', (e) => {
      const payload = e.payload as OpenFilePayload;
      if (payload && typeof payload.path === 'string') handler(payload);
    });
  }

  /**
   * Wave14：Rust 读盘失败（文件被删/移动/不可读）时 emit 的轻量错误。
   * 外壳不 panic、不弹窗，前端据此 toast 一句友好提示。
   */
  onOpenFileErrorEvent(handler: (err: { path: string; message: string }) => void): Promise<() => void> {
    if (!this.tauri.event) return Promise.resolve(() => undefined);
    return this.tauri.event.listen('app:open-file-error', (e) => {
      const payload = e.payload as { path?: string; message?: string };
      if (payload && typeof payload.message === 'string') {
        handler({ path: payload.path ?? '', message: payload.message });
      }
    });
  }

  /**
   * 原生系统通知（Windows Action Center）。
   * 浏览器端不调用本方法，走现有 in-app toast。集成期在保存成功/失败/
   * 迁移提示处判断 `host instanceof TauriHostAdapter` 后调用。
   */
  notify(title: string, body: string): Promise<void> {
    return this.invoke('notify', { title, body });
  }

  /**
   * 写一份带时间戳的备份到 app_data_dir/backups/，Rust 端自动裁剪到最近 20 份。
   * 集成期在自动保存成功后调用（500ms 防抖由调用方控制）。
   */
  backupDoc(title: string, text: string): Promise<string> {
    return this.invoke<string>('backup_doc', { title, text });
  }

  // -------------------------------------------------------------------------
  // Wave12: 动态窗口标题 + 原生关闭守卫 + 原生打开（带 path）
  // -------------------------------------------------------------------------

  /** 打开 .kbnote 并拿回绝对 path（菜单「文件→打开」用，用于 bind_native_file）。 */
  async openKbnoteNative(): Promise<OpenKbnoteReply | null> {
    return this.invoke<OpenKbnoteReply | null>('open_kbnote');
  }

  /** 另存为…：强制弹保存对话框（覆盖 current_path 原地写盘的默认行为）。 */
  async saveKbnoteAs(filename: string, text: string): Promise<void> {
    try {
      await this.invoke<string>('save_kbnote', { filename, text, forcePick: true });
    } catch (err) {
      if (typeof err === 'string' && err === 'cancelled') return;
      throw err;
    }
  }

  /** 推送窗口标题（格式由前端定：脏=「● 标题 — drawpaper」）。 */
  setWindowTitle(title: string): Promise<void> {
    return this.invoke('set_window_title', { title });
  }

  /** 告知外壳：当前文档是否绑定了原生 .kbnote（None = IDB 文档，关闭不拦）。 */
  bindNativeFile(path: string | null): Promise<void> {
    return this.invoke('bind_native_file', { path });
  }

  /** 告知外壳：绑定的原生文件当前是否有未保存改动。 */
  setNativeDirty(dirty: boolean): Promise<void> {
    return this.invoke('set_native_dirty', { dirty });
  }

  /**
   * Wave13：把导出产物（PDF 位图 / PNG / SVG / MD）交 Rust 原生 Save 对话框写盘。
   *
   * - `suggestedName` 必须与浏览器下载链路逐字一致（含扩展名，如
   *   `读书笔记_20261006_横向.pdf`）；Rust 会补/对齐扩展名。
   * - `bytes` 任意 Blob，内部转标准 base64 传 `bytesBase64`。
   * - 用户取消对话框 → resolve `{status:'cancelled'}`，**调用方静默，绝不 toast**。
   * - 写盘 / 解码失败 → reject(string)，调用方 toast。
   */
  async saveExport(opts: {
    suggestedName: string;
    ext: ExportExt;
    bytes: Blob;
  }): Promise<ExportSaveOutcome> {
    const bytesBase64 = await blobToBase64(opts.bytes);
    return this.invoke<ExportSaveOutcome>('save_export', {
      suggestedName: opts.suggestedName,
      ext: opts.ext,
      bytesBase64,
    });
  }

  /** 三选对话框里选了「保存/不保存」之后真正退出（Rust 会绕过 CloseRequested 守卫）。 */
  forceQuit(): Promise<void> {
    return this.invoke('force_quit');
  }

  /** 订阅原生关闭请求（仅当绑定且脏时 Rust 才 emit）。 */
  onCloseRequested(handler: () => void): Promise<() => void> {
    if (!this.tauri.event) return Promise.resolve(() => undefined);
    return this.tauri.event.listen('app:close-requested', () => {
      handler();
    });
  }
}

/**
 * 工厂：按运行环境挑 HostAdapter。
 *  - Tauri WebView 内 → TauriHostAdapter（原生文件对话框/打印）
 *  - 普通浏览器/PWA → WebHostAdapter（File System Access + 下载降级）
 *
 * 集成点：packages/web/src/store/editor-store.ts 第 42 行
 *   `export const hostAdapter = new WebHostAdapter();`
 * 替换为：
 *   `export const hostAdapter = createBestHostAdapter();`
 * 仅此一行；其余业务代码零改动。
 */
export function createBestHostAdapter(): HostAdapter {
  const t = tauriGlobal();
  if (t && t.core) return new TauriHostAdapter();
  return new WebHostAdapter();
}

/** 缓存的导出用 TauriHostAdapter；浏览器环境为 null。 */
let exportHost: TauriHostAdapter | null | undefined;

/**
 * 给导出管线用的 TauriHostAdapter 取号。
 *  - 浏览器/PWA（无 __TAURI__）→ null，导出走既有 Blob 下载链路。
 *  - 桌面 WebView → 返回一个 TauriHostAdapter 实例（与 desktop-bridge 各自构造，
 *    共用同一条 __TAURI__ 通道，无状态冲突）。
 * 结果按环境缓存，避免每次导出都 new。
 */
export function getTauriExportHost(): TauriHostAdapter | null {
  if (exportHost !== undefined) return exportHost;
  try {
    exportHost = new TauriHostAdapter();
  } catch {
    exportHost = null;
  }
  return exportHost;
}

/** 测试钩子：重置缓存的导出 host（单测间隔离 window.__TAURI__ 桩）。 */
export function resetTauriExportHost(): void {
  exportHost = undefined;
}
