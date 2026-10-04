import type { ConflictResolution, PendingConflicts } from '@drawpaper/core';
import type { ConflictResolutionInput } from '@/editor/editor-api';

/**
 * ConflictBridge：把 core store 的 `deps.resolveConflictUi(pending)`（一个返回
 * Promise 的注入回调）与画布侧 `<ConflictDialog/>`（调 api.resolveConflicts /
 * api.cancelConflicts）接起来。
 *
 * 时序：
 *  - store.addEdge 检测到多父/成环 → set pendingConflicts → 调 handler(pending)；
 *  - handler 返回一个挂起 Promise；弹窗因 state.pendingConflicts 非空而出现；
 *  - 用户在弹窗点「确定」→ adapter.api.resolveConflicts(r) → bridge.resolve(r)；
 *  - 用户点「取消」/关闭弹窗 → adapter.api.cancelConflicts() → bridge.resolve(null)
 *    （store 收到 null 即按 §6 精确回滚本次触发边）。
 *  - 弹窗期间若又来一次冲突（不应发生），先把上一次按取消处理，避免重弹。
 */
export interface ConflictBridge {
  /** 注入 store：deps.resolveConflictUi = bridge.handler。 */
  handler(pending: PendingConflicts): Promise<ConflictResolution | null>;
  /** 弹窗「确定」：落定裁决。 */
  resolve(r: ConflictResolutionInput): void;
  /** 弹窗「取消」/关闭：回滚新边。 */
  cancel(): void;
}

export function createConflictBridge(): ConflictBridge {
  let pending: ((r: ConflictResolution | null) => void) | null = null;

  return {
    handler(_pending) {
      // 弹窗期间不重复弹：若已有挂起，先按取消收尾（store 会回滚那次触发）。
      if (pending) {
        pending(null);
        pending = null;
      }
      return new Promise<ConflictResolution | null>((resolve) => {
        pending = resolve;
      });
    },
    resolve(r) {
      const finish = pending;
      pending = null;
      finish?.(r);
    },
    cancel() {
      const finish = pending;
      pending = null;
      finish?.(null);
    },
  };
}
