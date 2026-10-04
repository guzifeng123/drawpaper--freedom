import * as React from 'react';
import { FileText, FilePlus2, Copy, Trash2, Pencil, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { PanelsApi, DocMeta } from './panels-api';

/** 友好相对时间（"刚刚 / n 分钟前 / n 小时前 / MM-DD"）。 */
function friendlyTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function DocRow({
  doc,
  active,
  api,
}: {
  doc: DocMeta;
  active: boolean;
  api: PanelsApi;
}) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(doc.title);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (editing) requestAnimationFrame(() => inputRef.current?.select());
  }, [editing]);

  const commit = () => {
    const t = value.trim();
    if (t) api.renameDoc(doc.id, t);
    setEditing(false);
  };

  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm',
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
      )}
    >
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      {editing ? (
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="h-6 flex-1 px-1 text-xs"
        />
      ) : (
        <button
          type="button"
          className="flex-1 truncate text-left"
          onClick={() => api.openDoc(doc.id)}
          onDoubleClick={() => setEditing(true)}
          title={`${doc.title} · ${friendlyTime(doc.updatedAt)}更新`}
        >
          <span className="block truncate">{doc.title}</span>
          <span className="block text-[10px] text-muted-foreground">{friendlyTime(doc.updatedAt)}</span>
        </button>
      )}

      <div className="hidden shrink-0 items-center group-hover:flex">
        <button
          type="button"
          title="重命名"
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          onClick={() => setEditing(true)}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="复制"
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          onClick={() => api.duplicateDoc(doc.id)}
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="删除"
          className="rounded p-1 text-muted-foreground hover:text-destructive"
          onClick={() => setConfirmOpen(true)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="删除文档？"
        description={`将永久删除「${doc.title}」，此操作不可撤销。`}
        confirmText="删除"
        onConfirm={() => api.removeDoc(doc.id)}
      />
    </div>
  );
}

/**
 * 左侧可折叠文档列表。
 */
export const DocsListPanel = React.memo(function DocsListPanel({ api }: { api: PanelsApi }) {
  const [collapsed, setCollapsed] = React.useState(false);

  if (collapsed) {
    return (
      <aside className="absolute bottom-4 left-4 top-16 z-10 flex w-10 flex-col items-center rounded-lg border bg-card/95 py-2 shadow-sm">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="展开文档列表"
          className="rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <FileText className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="absolute bottom-4 left-4 top-16 z-10 flex w-56 flex-col rounded-lg border bg-card/95 shadow-sm">
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <span className="text-xs font-semibold text-muted-foreground">文档</span>
        <div className="flex items-center">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => api.newDoc()} title="新建文档">
            <FilePlus2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setCollapsed(true)}
            title="收起列表"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1 p-1">
        {api.docs.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            还没有文档
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {api.docs.map((d) => (
              <DocRow key={d.id} doc={d} active={d.id === api.currentDocId} api={api} />
            ))}
          </div>
        )}
      </ScrollArea>
    </aside>
  );
});
