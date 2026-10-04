import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import type { PanelsApi } from './panels-api';
import { TAG_SWATCHES } from './lib/tag-filter';

/**
 * 全局标签管理弹层（Wave3-H §4.8）：
 * - 新建标签（名字 + 8 色板 + 自定义 hex）；
 * - 改名 / 改色 / 删除（删除有确认，会从所有节点摘除）；
 * - 节点打标签的入口在编辑器 hover 工具条（已存在），本弹层只管标签表。
 */
export const TagManagerDialog = React.memo(function TagManagerDialog({
  open,
  onOpenChange,
  api,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: PanelsApi;
}) {
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState<string>(TAG_SWATCHES[0] as string);
  const [customColor, setCustomColor] = React.useState('');
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState('');

  const submitNew = () => {
    const n = name.trim();
    if (!n) return;
    const finalColor = /^#[0-9a-fA-F]{6}$/.test(customColor.trim())
      ? customColor.trim()
      : color;
    api.createTag(n, finalColor);
    setName('');
    setCustomColor('');
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>标签管理</DialogTitle>
            <DialogDescription>
              新建、改名、改色或删除标签；节点打标签在画布块的 hover 工具条。
            </DialogDescription>
          </DialogHeader>

          {/* 已有标签列表 */}
          <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
            {api.tags.length === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground">还没有标签</div>
            ) : (
              api.tags.map((t) => (
                <div key={t.id} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-accent/60">
                  <button
                    type="button"
                    title="点击改色"
                    className="h-4 w-4 shrink-0 rounded-full border border-border"
                    style={{ backgroundColor: t.color }}
                    onClick={() => setColor(t.color)}
                  />
                  {renamingId === t.id ? (
                    <Input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => {
                        const v = renameValue.trim();
                        if (v) api.renameTag(t.id, v);
                        setRenamingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const v = renameValue.trim();
                          if (v) api.renameTag(t.id, v);
                          setRenamingId(null);
                        }
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      className="h-6 flex-1 px-1 text-xs"
                    />
                  ) : (
                    <span
                      className="flex-1 truncate text-sm"
                      onDoubleClick={() => {
                        setRenamingId(t.id);
                        setRenameValue(t.name);
                      }}
                      title="双击改名"
                    >
                      {t.name}
                    </span>
                  )}
                  {/* 迷你色板：点击即改色 */}
                  <div className="hidden items-center gap-0.5 lg:flex">
                    {TAG_SWATCHES.slice(0, 6).map((c) => (
                      <button
                        key={c}
                        type="button"
                        title={`改成 ${c}`}
                        className={cn(
                          'h-3 w-3 rounded-full border border-border',
                          t.color === c && 'ring-1 ring-foreground',
                        )}
                        style={{ backgroundColor: c }}
                        onClick={() => api.changeTagColor(t.id, c)}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    title="删除标签"
                    className="rounded p-1 text-muted-foreground hover:text-destructive"
                    onClick={() => setDeletingId(t.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>

          {/* 新建标签 */}
          <div className="mt-2 flex flex-col gap-2 border-t pt-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitNew()}
              placeholder="新标签名字…"
              className="h-8 text-sm"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {TAG_SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={c}
                  className={cn(
                    'h-5 w-5 rounded-full border border-border',
                    color === c && !/^#[0-9a-fA-F]{6}$/.test(customColor) && 'ring-2 ring-foreground',
                  )}
                  style={{ backgroundColor: c }}
                  onClick={() => {
                    setColor(c);
                    setCustomColor('');
                  }}
                />
              ))}
              <Input
                value={customColor}
                onChange={(e) => setCustomColor(e.target.value)}
                placeholder="#hex"
                className="h-6 w-20 px-1.5 text-xs"
              />
              <Button size="sm" onClick={submitNew} disabled={!name.trim()}>
                <Plus className="h-3.5 w-3.5" /> 新建
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deletingId !== null}
        onOpenChange={(o) => !o && setDeletingId(null)}
        title="删除标签？"
        description="删除后会从所有节点上摘除该标签，此操作不可撤销。"
        confirmText="删除"
        onConfirm={() => {
          if (deletingId) api.deleteTag(deletingId);
          setDeletingId(null);
        }}
      />
    </>
  );
});
