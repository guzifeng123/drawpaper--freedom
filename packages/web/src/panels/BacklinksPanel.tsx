import * as React from 'react';
import { ArrowLeftRight, CornerDownRight, FileWarning } from 'lucide-react';
import type { PanelsApi } from './panels-api';
import { loadBacklinks, type BacklinkEntry } from '../storage/backlinks';

/**
 * BacklinksPanel：当前文档 / 当前块两个维度的反链列表。
 * - 文档级：谁引用了本文档的任意块。
 * - 块级（backlinksNodeId）：谁引用了正在查看的块。
 * 点击条目 → openDocRef（文档内 flyTo / 跨文档切换+聚焦）。
 */
export function BacklinksPanel({ api }: { api: PanelsApi }) {
  const doc = api.doc;
  const nodeId = api.backlinksNodeId;
  const [entries, setEntries] = React.useState<BacklinkEntry[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!doc) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void loadBacklinks(doc, doc.id, nodeId).then((rows) => {
      if (cancelled) return;
      setEntries(rows);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [doc, nodeId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b px-3 py-2 text-xs font-medium">
        <ArrowLeftRight size={13} />
        <span>{nodeId ? '块反链' : '文档反链'}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {loading && <div className="px-2 py-3 text-xs text-slate-400">加载中…</div>}
        {!loading && entries.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-slate-400">
            暂无反向链接
            <div className="mt-1 text-[10px]">在其他块里输入 [[ 即可引用到这里</div>
          </div>
        )}
        {entries.map((e) => (
          <button
            key={e.linkId}
            className="mb-1 flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-[hsl(var(--accent))]"
            onClick={() => api.openDocRef(e.sourceDocId, e.sourceNodeId)}
          >
            <CornerDownRight size={12} className="mt-0.5 shrink-0 text-slate-400" />
            <span className="flex-1 min-w-0">
              <span className="block truncate">{e.sourceNodeTitle}</span>
              <span className="block truncate text-[10px] text-slate-400">{e.sourceDocTitle}</span>
            </span>
            {e.dangling && <FileWarning size={12} className="mt-0.5 shrink-0 text-red-500" />}
          </button>
        ))}
      </div>
    </div>
  );
}
