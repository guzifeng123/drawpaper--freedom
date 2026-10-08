import { estimateStorageQuota } from '@/storage/fsa';
import { classifyQuotaState, type StorageEstimate, type QuotaState } from '@/storage/quota-policy';
import { detectTauriHost } from './welcome-doc';
import { getWiringUi } from './ui-store';

/**
 * Wave21：配额预检 + 弹窗触发（wiring 层，可安全 import ui-store / host 探测）。
 *
 * host 门控：Tauri 桌面端永远不弹这套浏览器引导——桌面走原生 Save 对话框
 * （tauri-host.ts），浏览器 PWA 才需要「导出到文件 / 分享」引导。
 */

/** 临界提示两次弹出的最小间隔（防自动保存每 500ms 刷一次弹窗）。 */
const CRITICAL_REOPEN_MIN_INTERVAL_MS = 10 * 60_000;
let lastCriticalOpenAt = 0;

/** 打开「存储空间不足」引导弹窗（Tauri 桌面端直接 no-op）。 */
export function openQuotaDialog(estimate: StorageEstimate | null = null): void {
  if (detectTauriHost()) return;
  getWiringUi().setQuotaDialog(true, estimate);
}

/** 关闭弹窗。 */
export function closeQuotaDialog(): void {
  getWiringUi().setQuotaDialog(false, null);
}

/**
 * 写入 QuotaExceededError 时拉起引导弹窗，并顺手读一次实时 estimate 填充用量。
 * Tauri 桌面端 no-op（host 门控）。estimate 读取失败/不支持 → 弹窗仍开，用量区兜底文案。
 */
export async function raiseQuotaDialog(): Promise<void> {
  if (detectTauriHost()) return;
  const est = await estimateStorageQuota().catch(() => null);
  getWiringUi().setQuotaDialog(true, est);
}

/**
 * 写入前/启动时预检：estimate() 取 usage/quota，临界且未在节流窗口内则弹引导。
 * 返回档位供调用方/dev-hook 检视；estimate 不可用（旧 Safari）返回 'unavailable'，
 * 不猜测、不弹窗。
 */
export async function checkQuotaPressure(): Promise<QuotaState> {
  if (detectTauriHost()) return 'unavailable';
  const est = await estimateStorageQuota();
  const state = classifyQuotaState(est);
  if (state === 'critical') {
    const now = Date.now();
    if (now - lastCriticalOpenAt >= CRITICAL_REOPEN_MIN_INTERVAL_MS) {
      lastCriticalOpenAt = now;
      openQuotaDialog(est);
    }
  }
  return state;
}

/** 测试：重置临界弹窗节流窗口。 */
export function __resetQuotaWatchThrottle(): void {
  lastCriticalOpenAt = 0;
}
