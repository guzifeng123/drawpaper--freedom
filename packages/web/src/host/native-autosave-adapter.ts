import { serializeKBNote } from '@drawpaper/core';
import { editorStore } from '@/store/editor-store';
import { syncStamper } from '@/sync/stamper';
import { getAsset } from '@/storage/opfs';

/**
 * Wave17：原生文件夹自动保存适配器（桌面 Tauri 独占）。
 *
 * 定位：浏览器/未配置目录时整体 no-op，现有 OPFS + IndexedDB 自动保存零变化。
 * Tauri 且用户已选定目录后：订阅现有文档保存/变更流水线（500ms 防抖），用
 * **既有** `serializeKBNote` 产出字节，按 FSA 同步通道同款相对路径经
 * `invoke('autosave_write_file')` 写文档本体 + 把 assetRefs 对应资产字节从 OPFS
 * 读出后写到 `assets/<ref>`。
 *
 * 与 FSA 通道（packages/web/src/sync/fsachannel.ts）逐字节对齐：
 *   * 文档：`<docId>.kbnote`（目录根），内容 = serializeKBNote(stampForPersist(doc))；
 *   * 资产：`assets/<assetRef>`（assetRef = OPFS 内容寻址 SHA-256 hex）。
 *
 * 本适配器**不**实现第二套文档格式、不做冲突合并/同步水位/GC——它只是
 * 一条「本地磁盘 durability mirror」，与 Dexie 自动保存并行，失败静默降级。
 * 零网络：全部调用只碰本地磁盘。
 */

/** Tauri 注入的最小全局形状（与 tauri-host.ts duck-type 同源，不引 SDK）。 */
interface TauriGlobal {
  core?: {
    invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  };
}

function tauriGlobal(): TauriGlobal | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return w && '__TAURI__' in w ? (w.__TAURI__ as TauriGlobal) : null;
}

/** 是否运行在 Tauri 桌面 WebView 内（设置面板据此决定是否显示本入口）。 */
export function isNativeAutosaveRuntime(): boolean {
  return tauriGlobal() !== null;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = tauriGlobal();
  if (!t || !t.core) return Promise.reject(new Error('native autosave: no __TAURI__.core'));
  return t.core.invoke<T>(cmd, args);
}

// ---------------------------------------------------------------------------
// 纯函数（单测直测）。
// ---------------------------------------------------------------------------

/** Uint8Array → 标准 base64（无换行，32KB 分块避免 btoa 栈溢出）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 文档本体相对路径：与 FSA 通道 `pushDoc` 完全一致。 */
export function docRelPath(docId: string): string {
  return `${docId}.kbnote`;
}

/** 资产相对路径：与 FSA 通道 `pushAsset` 完全一致（assets/<ref>）。 */
export function assetRelPath(ref: string): string {
  return `assets/${ref}`;
}

// ---------------------------------------------------------------------------
// 适配器内部状态。
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 500;

let started = false;
let active = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let unsubscribe: (() => void) | undefined;
/** 本会话已写入目标目录的资产 ref（内容寻址幂等，避免重复读 OPFS/写盘）。 */
let writtenAssets = new Set<string>();

/** 实际落盘一轮：写 .kbnote 本体 + 增量写 assetRefs 资产。任何失败静默降级。 */
async function flushOnce(): Promise<void> {
  if (!active) return;
  const doc = editorStore.getState().doc;
  let relPath = '';
  try {
    const text = serializeKBNote(syncStamper.stampForPersist(doc));
    relPath = docRelPath(doc.id);
    await invoke('autosave_write_file', {
      relPath,
      bytesBase64: bytesToBase64(new TextEncoder().encode(text)),
    });
  } catch (e) {
    // 写盘失败不阻断 Dexie 主保存；下轮防抖重试。
    console.warn('[native-autosave] doc write failed, degrading to local store:', e);
    return;
  }
  // 资产：只写本会话尚未写过的 ref（幂等；跨会话重写无害）。
  for (const ref of doc.assetRefs) {
    if (writtenAssets.has(ref)) continue;
    try {
      const blob = await getAsset(ref);
      if (!blob) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await invoke('autosave_write_file', {
        relPath: assetRelPath(ref),
        bytesBase64: bytesToBase64(bytes),
      });
      writtenAssets.add(ref);
    } catch (e) {
      console.warn('[native-autosave] asset write failed for ref:', ref, e);
    }
  }
}

function scheduleFlush(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void flushOnce();
  }, DEBOUNCE_MS);
}

/** 运行时开关：dir 非空即激活镜像；null 即停用。 */
function setActive(dir: string | null): void {
  active = !!dir;
  if (!active) {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    writtenAssets = new Set();
    return;
  }
  // 新目录：本会话已写资产集合失效，立即全量落盘一次。
  writtenAssets = new Set();
  scheduleFlush();
}

// ---------------------------------------------------------------------------
// 生命周期（App 挂载时一行注册）。
// ---------------------------------------------------------------------------

/**
 * App 挂载时调用一次。非 Tauri 环境直接返回 no-op 清理函数（零副作用）。
 * 重复调用幂等。
 */
export function initNativeAutosave(): () => void {
  if (started) return () => undefined;
  if (!isNativeAutosaveRuntime()) return () => undefined;
  started = true;

  // 启动时查询已配置目录；未配置则保持 no-op。
  void invoke<string | null>('autosave_get_dir')
    .then((dir) => {
      setActive(dir);
    })
    .catch(() => {
      /* 未配置 / 命令不可用：保持 no-op */
    });

  unsubscribe = editorStore.subscribe((state, prev) => {
    if (!active) return;
    // 只在文档本体变化时调度（viewport/selection 抖动不触发写盘）。
    if (state.doc !== prev.doc) scheduleFlush();
  });

  exposeDevHook();

  return () => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    active = false;
    started = false;
  };
}

// ---------------------------------------------------------------------------
// 设置面板入口（Tauri 内才显示）。
// ---------------------------------------------------------------------------

/** 查询当前已配置目录（绝对路径）；未配置/非 Tauri 返回 null。 */
export async function getNativeAutosaveDir(): Promise<string | null> {
  if (!isNativeAutosaveRuntime()) return null;
  try {
    return await invoke<string | null>('autosave_get_dir');
  } catch {
    return null;
  }
}

/** 弹原生目录选择框；选中后激活镜像并立即全量落盘一次。取消返回 null。 */
export async function pickNativeAutosaveFolder(): Promise<string | null> {
  if (!isNativeAutosaveRuntime()) return null;
  try {
    const dir = await invoke<string | null>('autosave_pick_dir');
    if (dir) setActive(dir);
    return dir;
  } catch {
    return null;
  }
}

/** 取消自动保存：清空配置、停用镜像。 */
export async function clearNativeAutosaveFolder(): Promise<void> {
  if (!isNativeAutosaveRuntime()) return;
  try {
    await invoke('autosave_clear_dir');
  } catch {
    /* 忽略 */
  }
  setActive(null);
}

// ---------------------------------------------------------------------------
// DEV-only e2e 钩子（生产构建被 tree-shake）。
// ---------------------------------------------------------------------------

function exposeDevHook(): void {
  if (!import.meta.env.DEV) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  w.__nativeAutosave = {
    /** 测试 seam：绕过原生对话框，直接把镜像开关置为某目录/停用。 */
    setConfigured: (dir: string | null) => setActive(dir),
    isActive: () => active,
    writtenAssetRefs: () => [...writtenAssets],
    flush: () => flushOnce(),
  };
}
