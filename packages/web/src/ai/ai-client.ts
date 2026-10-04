import type { KBNoteDoc, AIProvider, AiTask, AiSuggestion } from '@drawpaper/core';
import { buildAiMessages, validateAiOutput } from '@drawpaper/core/ai';
import type { AiConfig } from './ai-settings';

/**
 * AI 客户端编排：读文档 → 构造 messages → provider.chat → 容错解析 → schema 校验。
 * 任何网络 / 解析 / 校验失败都返回失败态，**绝不改动文档**。
 */

export type AiClientResult =
  | { ok: true; suggestions: AiSuggestion[]; warnings: string[] }
  | { ok: false; message: string };

/** 剥离 ```json ... ``` 代码块包裹，取出 JSON 本体。 */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf('[');
  const objStart = body.indexOf('{');
  const from = start === -1 ? objStart : objStart === -1 ? start : Math.min(start, objStart);
  if (from === -1) throw new Error('模型输出中找不到 JSON 数组/对象。');
  const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
  if (end === -1 || end < from) throw new Error('模型输出 JSON 不完整。');
  return JSON.parse(body.slice(from, end + 1));
}

export async function runAiTask(
  doc: KBNoteDoc,
  task: AiTask,
  config: AiConfig,
  provider: AIProvider,
): Promise<AiClientResult> {
  if (!config.endpoint || !config.apiKey || !config.model) {
    return { ok: false, message: '尚未配置 AI endpoint / key / model，请先在「AI 设置」里填写。' };
  }
  const nodeIds = new Set(doc.nodes.map((n) => n.id));
  try {
    const messages = buildAiMessages(doc, task);
    const resp = await provider.chat({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model,
      messages,
      responseFormat: 'json',
      temperature: config.temperature,
    });
    const raw = extractJson(resp.content);
    const result = validateAiOutput(raw, nodeIds);
    if (!result.ok) {
      return { ok: false, message: result.errors.join('；') || '模型输出未通过校验。' };
    }
    return { ok: true, suggestions: result.suggestions, warnings: result.errors };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
