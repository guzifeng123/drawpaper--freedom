/**
 * 定时备份调度器（web 接线层，零 DOM 依赖、时钟可注入，便于 fake-timer 单测）。
 *
 * 行为：
 *  - backupEnabled 开启且当前文档 dirty 时，每 intervalMs 触发一次 .kbnote 备份下载；
 *  - 无 dirty → 跳过（不重复备份）；
 *  - 关闭开关 / 切换文档 → 停止；
 *  - 备份完成后清 dirty（经 onBackupDone）。
 *
 * 调度本身不碰 DOM：备份动作、toast、时钟全部由调用方注入。
 */

export interface BackupDeps {
  /** 是否开启定时备份。 */
  isEnabled: () => boolean;
  /** 当前文档是否有未备份改动。 */
  isDirty: () => boolean;
  /** 执行一次备份（下载/写副本）。 */
  runBackup: () => void;
  /** 备份完成回调（清 dirty / toast）。 */
  onBackupDone?: () => void;
  /** 注入时钟（默认全局 setTimeout）。 */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

export const BACKUP_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟，集中常量

export interface BackupScheduler {
  start(): void;
  stop(): void;
  /** 文档切换/改动后调用：重置计时。 */
  reset(): void;
}

export function createBackupScheduler(deps: BackupDeps, intervalMs: number = BACKUP_INTERVAL_MS): BackupScheduler {
  const setI = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearI = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setTimeout>));
  let handle: unknown = null;

  const tick = () => {
    if (!deps.isEnabled()) return;
    if (!deps.isDirty()) return; // 无改动不重复备份
    deps.runBackup();
    deps.onBackupDone?.();
  };

  const start = () => {
    stop();
    handle = setI(tick, intervalMs);
  };
  const stop = () => {
    if (handle !== null) {
      clearI(handle);
      handle = null;
    }
  };
  const reset = () => start();

  return { start, stop, reset };
}
