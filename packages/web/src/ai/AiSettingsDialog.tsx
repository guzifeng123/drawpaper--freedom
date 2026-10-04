import * as React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/panels/lib/toast';
import { loadAiConfig, saveAiConfig, ENDPOINT_PRESETS, type AiConfig } from './ai-settings';
import { OpenAICompatProvider } from './openai-provider';

/**
 * AI 设置弹窗：endpoint / key(password) / model / 温度；存 localStorage。
 * 「测试连接」发一条极简请求；明确隐私说明（key 仅存本机浏览器）。
 */
export function AiSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const toast = useToast();
  const [cfg, setCfg] = React.useState<AiConfig>(() => loadAiConfig());
  const [testing, setTesting] = React.useState(false);

  React.useEffect(() => {
    if (open) setCfg(loadAiConfig());
  }, [open]);

  const save = () => {
    saveAiConfig(cfg);
    toast.success('AI 设置已保存（仅存本机浏览器）。');
    onOpenChange(false);
  };

  const testConnection = async () => {
    if (!cfg.endpoint || !cfg.apiKey || !cfg.model) {
      toast.warn('请先填完 endpoint / key / model。');
      return;
    }
    setTesting(true);
    try {
      const provider = new OpenAICompatProvider();
      const resp = await provider.chat({
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey,
        model: cfg.model,
        messages: [
          { role: 'system', content: '只回复 ok。' },
          { role: 'user', content: 'ping' },
        ],
        temperature: 0,
      });
      if (resp.content) toast.success(`连接成功，模型已响应：${resp.content.slice(0, 40)}`);
      else toast.warn('连接成功但未返回内容。');
    } catch (err) {
      toast.error(`连接失败：${err instanceof Error ? err.message : String(err)}`, 4000);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>AI 辅助设置</DialogTitle>
          <DialogDescription>
            自带 OpenAI 兼容 endpoint 与 key。除你填写的 endpoint 外，应用不会发起任何网络请求。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="ai-endpoint">API Base URL</Label>
            <Input
              id="ai-endpoint"
              placeholder="https://api.openai.com/v1"
              value={cfg.endpoint}
              onChange={(e) => setCfg({ ...cfg, endpoint: e.target.value })}
            />
            <div className="flex flex-wrap gap-1.5">
              {ENDPOINT_PRESETS.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                  onClick={() => setCfg({ ...cfg, endpoint: p.endpoint, model: p.model })}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="ai-key">API Key</Label>
            <Input
              id="ai-key"
              type="password"
              placeholder="sk-..."
              value={cfg.apiKey}
              onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="ai-model">模型</Label>
              <Input
                id="ai-model"
                placeholder="gpt-4o-mini"
                value={cfg.model}
                onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ai-temp">温度（{cfg.temperature.toFixed(1)}）</Label>
              <Input
                id="ai-temp"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={cfg.temperature}
                onChange={(e) =>
                  setCfg({ ...cfg, temperature: Number(e.target.value) || 0 })
                }
              />
            </div>
          </div>

          <Separator />
          <p className="text-xs text-muted-foreground">
            隐私说明：key 仅保存在你本机浏览器的 localStorage 中，不会上传、不会遥测。AI 只产出经
            Schema 校验的建议，进 diff 清单由你逐条勾选后才会合入文档。
          </p>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={testConnection} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </Button>
          <Button onClick={save}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
