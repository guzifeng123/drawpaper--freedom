import * as React from 'react';
import { Camera, RotateCcw, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { PanelsApi, SnapshotInfo } from './panels-api';

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 快照历史（Wave3-H §4.1）：手动拍快照、预览、恢复（确认后替换当前内容，
 * 实现方需自动留一份「恢复前」快照以支持再恢复）、删除单条快照。
 */
export const SnapshotsDialog = React.memo(function SnapshotsDialog({
  open,
  onOpenChange,
  api,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: PanelsApi;
}) {
  const [label, setLabel] = React.useState('');
  const [restoreTarget, setRestoreTarget] = React.useState<SnapshotInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<SnapshotInfo | null>(null);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>快照历史</DialogTitle>
            <DialogDescription>
              随时手动拍快照；恢复会替换当前内容，并自动留恢复前快照以便反悔。
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="给这次快照起个名字（可选）…"
              className="h-8 text-sm"
            />
            <Button
              size="sm"
              onClick={() => {
                api.takeSnapshot(label.trim() || undefined);
                setLabel('');
              }}
            >
              <Camera className="h-3.5 w-3.5" /> 拍快照
            </Button>
          </div>

          <ScrollArea className="max-h-64">
            {api.snapshots.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">还没有快照</div>
            ) : (
              <div className="flex flex-col gap-1">
                {api.snapshots.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-2 rounded border border-border px-2 py-1.5"
                  >
                    <div className="flex-1">
                      <div className="text-sm">{s.label || '自动快照'}</div>
                      <div className="text-xs text-muted-foreground">
                        {fmtTime(s.at)} · 「{s.docTitle}」
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="恢复到此快照"
                      onClick={() => setRestoreTarget(s)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> 恢复
                    </Button>
                    <button
                      type="button"
                      title="删除快照"
                      className="rounded p-1 text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteTarget(s)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(o) => !o && setRestoreTarget(null)}
        title="恢复到此快照？"
        description={restoreTarget
          ? `将把当前内容替换为「${restoreTarget.label || '自动快照'}」（${fmtTime(restoreTarget.at)}）的状态；恢复前会自动留一份快照，可再恢复。`
          : undefined}
        confirmText="恢复"
        danger={false}
        onConfirm={() => {
          if (restoreTarget) api.restoreSnapshot(restoreTarget.id);
          setRestoreTarget(null);
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="删除这条快照？"
        description="删除后不可恢复。"
        confirmText="删除"
        onConfirm={() => {
          if (deleteTarget) api.deleteSnapshot(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </>
  );
});
