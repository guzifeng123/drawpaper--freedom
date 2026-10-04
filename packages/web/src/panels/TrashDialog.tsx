import * as React from 'react';
import { RotateCcw, Trash2, FileText } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { PanelsApi, TrashItem } from './panels-api';

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 回收站（Wave3-H §4.1）：恢复、彻底删除（确认）、清空（确认）。
 */
export const TrashDialog = React.memo(function TrashDialog({
  open,
  onOpenChange,
  api,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: PanelsApi;
}) {
  const [purgeTarget, setPurgeTarget] = React.useState<TrashItem | null>(null);
  const [confirmEmpty, setConfirmEmpty] = React.useState(false);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>回收站</DialogTitle>
            <DialogDescription>
              删除的文档与旧快照先放在这里；彻底删除后不可恢复。
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-64">
            {api.trash.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">回收站是空的</div>
            ) : (
              <div className="flex flex-col gap-1">
                {api.trash.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-2 rounded border border-border px-2 py-1.5"
                  >
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="flex-1">
                      <div className="text-sm">{t.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {t.kind === 'doc' ? '文档' : '快照'} · {fmtTime(t.deletedAt)} 删除
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => api.restoreFromTrash(t.id)}>
                      <RotateCcw className="h-3.5 w-3.5" /> 恢复
                    </Button>
                    <button
                      type="button"
                      title="彻底删除"
                      className="rounded p-1 text-muted-foreground hover:text-destructive"
                      onClick={() => setPurgeTarget(t)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>

          {api.trash.length > 0 ? (
            <div className="flex justify-end border-t pt-3">
              <Button variant="outline" size="sm" onClick={() => setConfirmEmpty(true)}>
                <Trash2 className="h-3.5 w-3.5" /> 清空回收站
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={purgeTarget !== null}
        onOpenChange={(o) => !o && setPurgeTarget(null)}
        title="彻底删除？"
        description={`「${purgeTarget?.title ?? ''}」将被永久删除，不可恢复。`}
        confirmText="彻底删除"
        onConfirm={() => {
          if (purgeTarget) api.purgeFromTrash(purgeTarget.id);
          setPurgeTarget(null);
        }}
      />

      <ConfirmDialog
        open={confirmEmpty}
        onOpenChange={setConfirmEmpty}
        title="清空回收站？"
        description={`回收站里的 ${api.trash.length} 条内容将被永久删除，不可恢复。`}
        confirmText="清空"
        onConfirm={() => api.emptyTrash()}
      />
    </>
  );
});
