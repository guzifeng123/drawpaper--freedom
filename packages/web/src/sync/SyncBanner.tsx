import { useSyncUi } from './sync-ui-store';

/**
 * 同步冲突横幅（Wave10 阶段 B）：跨设备合并产生冲突时顶部提示。
 * 复用 Wave9 CollabBanner 的形状与中文摘要（mergeSnapshots().summary）。
 * 关闭即视为「已知悉」；冲突副本已写入同步目录，可人工核对。
 */
export function SyncBanner() {
  const conflicts = useSyncUi((s) => s.conflicts);
  if (conflicts.length === 0) return null;
  return (
    <div
      className="absolute left-1/2 top-12 z-30 w-[min(680px,92vw)] -translate-x-1/2 rounded-lg border border-amber-400/60 bg-amber-50/95 px-3 py-2 text-amber-900 shadow-lg"
      data-testid="sync-conflict-banner"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-2 w-2 shrink-0 rounded-full bg-amber-500" />
        <span className="flex-1 text-xs font-medium" data-testid="sync-conflict-summary">
          检测到 {conflicts.length} 处跨设备冲突，已保留副本到同步目录
        </span>
        <button
          type="button"
          aria-label="关闭同步冲突横幅"
          className="shrink-0 rounded px-1 text-xs hover:bg-amber-100"
          onClick={() => useSyncUi.getState().clearConflicts()}
        >
          ×
        </button>
      </div>
      <ul className="mt-2 flex max-h-32 flex-col gap-1 overflow-auto border-t border-amber-200 pt-2 text-xs">
        {conflicts.map((c, i) => (
          <li key={i} className="rounded bg-white/70 px-2 py-1">
            {c}
          </li>
        ))}
      </ul>
    </div>
  );
}
