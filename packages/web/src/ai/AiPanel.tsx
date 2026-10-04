import * as React from 'react';
import { Sparkles, Settings2, Wand2, Scissors, Group, FileText, CircleDot } from 'lucide-react';
import type { KBNoteDoc, AiTask, AiSuggestion } from '@drawpaper/core';
import { Button } from '@/components/ui/button';
import { useToast } from '@/panels/lib/toast';
import { loadAiConfig } from './ai-settings';
import { OpenAICompatProvider } from './openai-provider';
import { runAiTask } from './ai-client';
import type { AiApi } from './ai-api';
import { AiSettingsDialog } from './AiSettingsDialog';
import { AiDiffDialog } from './AiDiffDialog';

/**
 * AI 面板：五个动作按钮（一键整理 / 长文拆块 / 自动分组 / 摘要润色 / 孤立断点）。
 * 结果进 diff 清单；确认后调 api.applyAISuggestions，成功提示可手动整理布局。
 * 任何失败都 toast 明示且文档不变。
 */
const TASKS: Array<{ task: AiTask; label: string; Icon: typeof Wand2 }> = [
  { task: 'organize', label: '一键整理建议', Icon: Wand2 },
  { task: 'split', label: '长文拆块', Icon: Scissors },
  { task: 'group', label: '自动分组标题', Icon: Group },
  { task: 'summarize', label: '摘要润色', Icon: FileText },
  { task: 'gaps', label: '孤立断点检测', Icon: CircleDot },
];

export function AiPanel({ doc, api }: { doc: KBNoteDoc | null; api: AiApi }) {
  const toast = useToast();
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<AiTask | null>(null);
  const [diff, setDiff] = React.useState<{ suggestions: AiSuggestion[]; warnings: string[] } | null>(null);

  const run = async (task: AiTask) => {
    if (!doc) {
      toast.warn('当前没有打开的文档。');
      return;
    }
    const cfg = loadAiConfig();
    if (!cfg.endpoint || !cfg.apiKey || !cfg.model) {
      setSettingsOpen(true);
      toast.warn('请先在 AI 设置里填写 endpoint / key / model。');
      return;
    }
    setBusy(task);
    try {
      const result = await runAiTask(doc, task, cfg, new OpenAICompatProvider());
      if (!result.ok) {
        toast.error(`AI 失败：${result.message}（文档未改动）`, 4000);
        return;
      }
      if (result.suggestions.length === 0) {
        toast.success('AI 没有给出新的建议。');
        return;
      }
      setDiff({ suggestions: result.suggestions, warnings: result.warnings });
    } finally {
      setBusy(null);
    }
  };

  const onConfirm = async (accepted: ReadonlySet<number>) => {
    if (!diff) return;
    try {
      await api.applyAISuggestions(diff.suggestions, accepted);
      toast.success(`已合入 ${accepted.size} 条建议，可手动触发「一键整理」布局。`);
      setDiff(null);
    } catch (err) {
      toast.error(`合入失败：${err instanceof Error ? err.message : String(err)}`, 4000);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" /> AI 辅助
        </span>
        <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)} title="AI 设置">
          <Settings2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-1.5">
        {TASKS.map(({ task, label, Icon }) => (
          <Button
            key={task}
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void run(task)}
          >
            <Icon className="h-3.5 w-3.5" />
            {busy === task ? '思考中…' : label}
          </Button>
        ))}
      </div>

      <AiSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      {diff ? (
        <AiDiffDialog
          open
          suggestions={diff.suggestions}
          warnings={diff.warnings}
          onCancel={() => setDiff(null)}
          onConfirm={(accepted) => void onConfirm(accepted)}
        />
      ) : null}
    </div>
  );
}
