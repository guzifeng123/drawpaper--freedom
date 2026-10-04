import type { AIProvider, AIChatRequest, AIChatResponse } from '@drawpaper/core';

/**
 * OpenAI 兼容 provider：用原生 fetch 调 {endpoint}/chat/completions。
 * 不内置 key、不发遥测；除用户配置的 endpoint 外零网络请求。
 */
export class OpenAICompatProvider implements AIProvider {
  async chat(req: AIChatRequest): Promise<AIChatResponse> {
    const url = `${req.endpoint.replace(/\/$/, '')}/chat/completions`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature ?? 0.2,
        response_format: req.responseFormat === 'json' ? { type: 'json_object' } : undefined,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`AI 请求失败（HTTP ${resp.status}）：${text.slice(0, 200)}`);
    }
    const json = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    return { content };
  }
}
