/**
 * Wave21 WebKit/Safari 存储兼容兜底：配额策略纯函数（零 DOM / 零依赖，可单测）。
 *
 * 职责：
 *  - 把 navigator.storage.estimate() 的原始字节数分类成「充足 / 偏高 / 临界」；
 *  - 按宿主能力（是否 Tauri 桌面、是否有 Web Share、是否支持 FSA）决定
 *    「空间不足」提示弹窗里给用户哪些恢复动作；
 *  - 字节数人类可读格式化（提示 UI 展示用）。
 *
 * 这些函数故意不触碰 navigator / window：能力由调用方探测后以参数传入，
 * 这样在 jsdom 与任意 WebKit 版本下都能稳定单测。
 */

/** estimate() 返回的最小形状（与 fsa.estimateStorageQuota 对齐）。 */
export interface StorageEstimate {
  usage: number;
  quota: number;
}

/** 配额档位：unavailable = estimate() 不可用（防御性不弹临界提示）。 */
export type QuotaState = 'unavailable' | 'ok' | 'low' | 'critical';

/** usage/quota ≥ 0.80 → 偏高（写入前预检给一次温和提醒）。 */
export const QUOTA_WARN_RATIO = 0.8;
/** usage/quota ≥ 0.95 → 临界（写入 QuotaExceededError 或预检时弹导出引导）。 */
export const QUOTA_CRITICAL_RATIO = 0.95;

/**
 * 压力比 = usage / quota。非法输入（quota<=0、负数、非有限数）返回 0，
 * 防御旧 WebKit estimate() 全 0 或 undefined 字段导致的 NaN。
 */
export function quotaPressureRatio(usage: number, quota: number): number {
  if (!Number.isFinite(usage) || !Number.isFinite(quota)) return 0;
  if (usage <= 0 || quota <= 0) return 0;
  if (usage >= quota) return 1;
  return usage / quota;
}

/**
 * 分类配额档位。estimate 为 null（浏览器不支持 estimate()，如旧 Safari）
 * 一律返回 'unavailable' —— 不做猜测式弹窗。
 */
export function classifyQuotaState(
  estimate: StorageEstimate | null,
  warnRatio: number = QUOTA_WARN_RATIO,
  criticalRatio: number = QUOTA_CRITICAL_RATIO,
): QuotaState {
  if (!estimate || !Number.isFinite(estimate.quota) || estimate.quota <= 0) return 'unavailable';
  const ratio = quotaPressureRatio(estimate.usage, estimate.quota);
  if (ratio >= criticalRatio) return 'critical';
  if (ratio >= warnRatio) return 'low';
  return 'ok';
}

/** 人类可读字节数（B/KB/MB/GB，1 位小数）。非有限数兜底为 '—'。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** 空间不足提示里可提供的恢复动作。 */
export type RecoveryAction =
  /** 导出当前文档为 .kbnote（FSA 另存；不支持时 host 自动走 anchor 下载）。 */
  | 'export-file'
  /** 调用系统分享（Web Share API；宿主不支持时 host 内部降级为下载）。 */
  | 'share'
  /** 无 Web Share 的浏览器：直接导出 .kbpack 整库备份包下载。 */
  | 'download-backup-pack';

/** 宿主能力快照（由调用方探测后传入，保持本模块纯净）。 */
export interface RecoveryCapabilities {
  /** Tauri 桌面端：不弹这套浏览器提示（原生保存对话框，见 host 门控）。 */
  isTauri: boolean;
  /** navigator.share 是否可用（移动端 Safari 才有；桌面 Safari/Chrome 常无）。 */
  hasShare: boolean;
  /** File System Access 是否可用（仅 Chromium；Safari/WebKit 恒 false）。 */
  fsaSupported: boolean;
}

/**
 * 决定「空间不足」提示应给用户哪些动作。
 *
 * 规则：
 *  - Tauri 桌面端 → 空数组（host 门控：桌面用原生 Save 对话框，不弹浏览器引导）；
 *  - 任意浏览器 PWA → 永远有「导出当前文档 .kbnote」（FSA 或 anchor 下载）；
 *  - 有 Web Share → 额外给「分享…」；
 *  - 无 Web Share → 额外给「下载 .kbpack 整库备份包」兜底。
 *
 * fsaSupported 只影响文案/能力矩阵展示，不删减动作（不支持时 host 层自动降级下载）。
 */
export function selectRecoveryActions(cap: RecoveryCapabilities): RecoveryAction[] {
  if (cap.isTauri) return [];
  const actions: RecoveryAction[] = ['export-file'];
  actions.push(cap.hasShare ? 'share' : 'download-backup-pack');
  return actions;
}

/** 某动作是否应出现在弹窗里（供组件按能力矩阵渲染，避免硬编码）。 */
export function hasAction(actions: RecoveryAction[], action: RecoveryAction): boolean {
  return actions.includes(action);
}
