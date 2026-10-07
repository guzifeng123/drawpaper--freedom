import * as React from 'react';
import { RotateCcw, Trash2, FileText, HardDrive } from 'lucide-react';
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
import {
  runManualAssetCleanup,
  confirmEmptyRetention,
  retentionSize,
  retentionCount,
} from '@/storage/asset-gc-web';

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 人类可读体积（字节 → KB/MB）。 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 回收站（Wave3-H §4.1）：恢复、彻底删除（确认）、清空（确认）。
 * Wave16 F：附「清理未使用资产」——孤儿资产移入保留区，用户确认后才物理清除。
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
  const [retentionBytes, setRetentionBytes] = React.useState(0);
  const [retentionItems, setRetentionItems] = React.useState(0);
  const [scanResult, setScanResult] = React.useState<string>('');
  const [busy, setBusy] = React.useState(false);
  const [confirmPurgeRetention, setConfirmPurgeRetention] = React.useState(false);

  // 打开时刷新保留区体积。
  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      try {
        const [bytes, count] = await Promise.all([retentionSize(), retentionCount()]);
        if (!alive) return;
        setRetentionBytes(bytes);
        setRetentionItems(count);
      } catch {
        /* OPFS 不可用：静默，保留区不可用 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, api.trash.length]);

  const scanUnused = async () => {
    setBusy(true);
    try {
      const r = await runManualAssetCleanup();
      setScanResult(
        r.movedToRetention > 0
          ? `已把 ${r.movedToRetention} 个未使用资产移入保留区。`
          : '没有发现未使用资产。',
      );
      try {
        const [bytes, count] = await Promise.all([retentionSize(), retentionCount()]);
        setRetentionBytes(bytes);
        setRetentionItems(count);
      } catch { /* ignore */ }
    } finally {
      setBusy(false);
    }
  };

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

          {/* Wave16 F：未使用资产（孤儿 blob）清理入口。 */}
          <div className="mt-2 rounded border border-border p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <HardDrive className="h-4 w-4 text-muted-foreground" /> 未使用资产
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              保留区现占用 {fmtBytes(retentionBytes)}（{retentionItems} 项）。扫描会把无人引用的图片/附件移入保留区，确认后才物理删除。
            </div>
            {scanResult ? <div className="mt-1 text-xs">{scanResult}</div> : null}
            <div className="mt-2 flex gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void scanUnused()}>
                {busy ? '扫描中…' : '扫描未使用资产'}
              </Button>
              {retentionItems > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmPurgeRetention(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" /> 清空保留区
                </Button>
              ) : null}
            </div>
          </div>
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

      <ConfirmDialog
        open={confirmPurgeRetention}
        onOpenChange={setConfirmPurgeRetention}
        title="清空保留区？"
        description={`保留区里的 ${retentionItems} 个未使用资产（${fmtBytes(retentionBytes)}）将被永久删除，不可恢复。`}
        confirmText="物理删除"
        onConfirm={async () => {
          await confirmEmptyRetention();
          setConfirmPurgeRetention(false);
          try {
            setRetentionBytes(await retentionSize());
            setRetentionItems(await retentionCount());
          } catch { /* ignore */ }
          setScanResult('保留区已清空。');
        }}
      />
    </>
  );
});
