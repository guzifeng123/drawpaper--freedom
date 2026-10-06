import * as React from 'react';
import {
  ArrowRight,
  Flag,
  Group,
  Scissors,
  Sparkles,
  CheckSquare,
  Square,
} from 'lucide-react';
import type { AiSuggestion } from '@drawpaper/core';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

/**
 * AI diff 勾选清单：每条建议 = 类型图标 + 理由 + 涉及节点 + 勾选框。
 * 确认后回调 (accepted: Set<number>)，由上层调 api.applyAISuggestions。
 */
const KIND_META: Record<AiSuggestion['kind'], { label: string; Icon: typeof ArrowRight }> = {
  'add-edge': { label: '新增连线', Icon: ArrowRight },
  'set-root': { label: '指定主根', Icon: Flag },
  group: { label: '自动分组', Icon: Group },
  'split-block': { label: '长文拆块', Icon: Scissors },
  summarize: { label: '摘要润色', Icon: Sparkles },
};

function involvedIds(s: AiSuggestion): string[] {
  switch (s.kind) {
    case 'add-edge':
      return [s.source, s.target];
    case 'set-root':
      return [s.rootNodeId];
    case 'group':
      return s.memberNodeIds;
    case 'split-block':
      return [s.targetNodeId];
    case 'summarize':
      return [s.targetNodeId];
  }
}

export interface AiDiffDialogProps {
  open: boolean;
  suggestions: AiSuggestion[];
  warnings: string[];
  onCancel: () => void;
  onConfirm: (accepted: ReadonlySet<number>) => void;
}

export function AiDiffDialog({ open, suggestions, warnings, onCancel, onConfirm }: AiDiffDialogProps) {
  const [checked, setChecked] = React.useState<Set<number>>(new Set(suggestions.map((_, i) => i)));

  React.useEffect(() => {
    if (open) setChecked(new Set(suggestions.map((_, i) => i)));
  }, [open, suggestions]);

  const allChecked = checked.size === suggestions.length;
  const toggle = (i: number) => {
    const next = new Set(checked);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setChecked(next);
  };
  const toggleAll = () => {
    setChecked(allChecked ? new Set() : new Set(suggestions.map((_, i) => i)));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>AI 建议（{suggestions.length} 条）</DialogTitle>
          <DialogDescription>
            逐条勾选要合入的建议，确认后才会改动文档。
            {warnings.length > 0 ? `（${warnings.length} 条非法输出已自动丢弃）` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] overflow-y-auto">
          <button
            type="button"
            className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={toggleAll}
          >
            {allChecked ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
            全选 / 全不选
          </button>
          <ul className="flex flex-col gap-2">
            {suggestions.map((s, i) => {
              const meta = KIND_META[s.kind];
              const involved = involvedIds(s);
              return (
                <li key={i} className="flex items-start gap-3 rounded-md border p-2.5">
                  <Checkbox
                    checked={checked.has(i)}
                    onCheckedChange={() => toggle(i)}
                    aria-label={`选择建议 ${i + 1}：${meta.label}`}
                  />
                  <meta.Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-muted-foreground">{meta.label}</div>
                    <p className="text-sm">{s.reason}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {involved.map((id) => (
                        <code key={id} className="rounded bg-muted px-1.5 text-[10px]">
                          {id}
                        </code>
                      ))}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={() => onConfirm(checked)} disabled={checked.size === 0}>
            合入 {checked.size} 条
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
