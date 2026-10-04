import * as React from 'react';
import {
  BookOpen,
  Users,
  GraduationCap,
  Lightbulb,
  Network,
  Puzzle,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { PanelsApi } from './panels-api';
import { DOC_TEMPLATES, type DocTemplate } from './lib/templates';

const ICONS: Record<DocTemplate['icon'], React.ComponentType<{ className?: string }>> = {
  'book-open': BookOpen,
  users: Users,
  'graduation-cap': GraduationCap,
  lightbulb: Lightbulb,
  network: Network,
  puzzle: Puzzle,
};

/**
 * 模板库（Wave3-H §4.1）：6 份内置模板卡片，点击新建文档。
 */
export const TemplatesDialog = React.memo(function TemplatesDialog({
  open,
  onOpenChange,
  api,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: PanelsApi;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>模板库</DialogTitle>
          <DialogDescription>选一个模板新建文档，块结构会自动搭好骨架。</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {DOC_TEMPLATES.map((t) => {
            const Icon = ICONS[t.icon];
            return (
              <button
                key={t.id}
                type="button"
                className="flex flex-col gap-1.5 rounded-lg border border-border p-3 text-left transition-colors hover:border-primary hover:bg-accent/50"
                onClick={() => {
                  api.createDocFromTemplate(t.id);
                  onOpenChange(false);
                }}
              >
                <Icon className="h-5 w-5 text-primary" />
                <span className="text-sm font-medium">{t.name}</span>
                <span className="text-xs leading-relaxed text-muted-foreground">{t.description}</span>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
});
