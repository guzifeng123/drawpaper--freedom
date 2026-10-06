import { useState } from 'react';
import { useCollabUi } from './collab-ui-store';
import { collabManager } from './collab-manager';
import { editorStore } from '@/store/editor-store';
import { pushToast } from '@/panels/lib/toast';

/**
 * 协作冲突横幅：远端合并产生并发冲突（败方未静默丢弃）时，画布顶部汇总提示。
 *  - 折叠态：一行中文摘要（summarizeConflicts）+ 展开/回滚按钮。
 *  - 展开态：逐条列出双方标签页 / 实体 / 字段 / 胜负值 / 原因。
 *  - 「回滚到合并前」：恢复最近一条「协作合并前」快照。
 */
export function CollabBanner() {
  const conflicts = useCollabUi((s) => s.conflicts);
  const expanded = useCollabUi((s) => s.conflictsExpanded);
  const setExpanded = (on: boolean) => useCollabUi.setState({ conflictsExpanded: on });
  const clear = () => useCollabUi.getState().clearConflicts();
  const [rollingBack, setRollingBack] = useState(false);

  if (conflicts.length === 0) return null;
  const summary = collabManager.conflictSummary();

  const rollback = async () => {
    setRollingBack(true);
    try {
      const docId = editorStore.getState().currentDocId;
      const metas = await editorStore.getState().listSnapshots(docId);
      const preMerge = metas.find((m) => m.label === '协作合并前');
      if (!preMerge) {
        pushToast('warn', '没有找到「协作合并前」快照，无法回滚');
        return;
      }
      await editorStore.getState().restoreSnapshot(preMerge.id);
      clear();
      pushToast('success', `已回滚到合并前快照（${new Date(preMerge.takenAt).toLocaleTimeString()}）`);
    } catch {
      pushToast('error', '回滚失败');
    } finally {
      setRollingBack(false);
    }
  };

  return (
    <div className="absolute left-1/2 top-3 z-30 w-[min(680px,92vw)] -translate-x-1/2 rounded-lg border border-amber-400/60 bg-amber-50/95 px-3 py-2 text-amber-900 shadow-lg">
      <div className="flex items-center gap-2">
        <span className="flex h-2 w-2 shrink-0 rounded-full bg-amber-500" />
        <span className="flex-1 truncate text-xs font-medium" data-testid="collab-conflict-summary">
          检测到 {conflicts.length} 处并发冲突（{summary[0]}）
        </span>
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-xs hover:bg-amber-100"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起' : `展开 ${conflicts.length} 条`}
        </button>
        <button
          type="button"
          disabled={rollingBack}
          className="shrink-0 rounded bg-amber-600 px-2 py-0.5 text-xs text-white hover:bg-amber-500 disabled:opacity-50"
          onClick={rollback}
        >
          {rollingBack ? '回滚中…' : '回滚到合并前'}
        </button>
        <button
          type="button"
          aria-label="关闭冲突横幅"
          className="shrink-0 rounded px-1 text-xs hover:bg-amber-100"
          onClick={clear}
        >
          ×
        </button>
      </div>
      {expanded ? (
        <ul className="mt-2 flex max-h-40 flex-col gap-1 overflow-auto border-t border-amber-200 pt-2 text-xs">
          {conflicts.map((_c, i) => (
            <li key={i} className="rounded bg-white/70 px-2 py-1">
              {summary[i]}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
