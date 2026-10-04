import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractJson, runAiTask } from './ai-client';
import type { AiConfig } from './ai-settings';
import type { KBNoteDoc } from '@drawpaper/core';

const doc = {
  id: 'd',
  title: 't',
  nodes: [
    { id: 'n1', content: { format: 'tiptap-json', data: { type: 'doc', content: [] } } },
    { id: 'n2', content: { format: 'tiptap-json', data: { type: 'doc', content: [] } } },
  ],
  edges: [],
} as unknown as KBNoteDoc;

const cfg: AiConfig = { endpoint: 'https://x/v1', apiKey: 'k', model: 'm', temperature: 0.2 };

describe('extractJson', () => {
  it('剥离 ```json 围栏', () => {
    expect(extractJson('```json\n[{"kind":"add-edge"}]\n```')).toEqual([{ kind: 'add-edge' }]);
  });
  it('容忍前后噪音文本', () => {
    expect(extractJson('好的，结果如下：[{"a":1}] 以上')).toEqual([{ a: 1 }]);
  });
  it('非 JSON 抛错', () => {
    expect(() => extractJson('没有数组')).toThrow();
  });
});

describe('runAiTask', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('成功路径：返回校验过的建议', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '[{"kind":"add-edge","reason":"r","source":"n1","target":"n2"}]' } }] }),
    } as Response);
    const provider = { chat: async (req: { endpoint: string }) => {
      const r = await fetchMock(`${req.endpoint}/chat/completions`, {});
      const j = await (r as Response).json();
      return { content: j.choices[0].message.content };
    } };
    const r = await runAiTask(doc, 'organize', cfg, provider as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.suggestions).toHaveLength(1);
  });

  it('HTTP 失败：返回 ok:false 且不抛', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500, text: async () => 'err' } as Response);
    const provider = { chat: async () => { throw new Error('HTTP 500'); } };
    const r = await runAiTask(doc, 'organize', cfg, provider as never);
    expect(r.ok).toBe(false);
  });

  it('缺配置：直接失败，不发请求', async () => {
    const provider = { chat: vi.fn() };
    const r = await runAiTask(doc, 'organize', { ...cfg, apiKey: '' }, provider as never);
    expect(r.ok).toBe(false);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('模型吐非 JSON：返回失败态', async () => {
    const provider = { chat: async () => ({ content: '完全不是 JSON' }) };
    const r = await runAiTask(doc, 'organize', cfg, provider as never);
    expect(r.ok).toBe(false);
  });
});
