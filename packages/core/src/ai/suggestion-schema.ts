import { z } from 'zod';

/**
 * AI 输出 Schema 校验（core 纯逻辑，零 DOM）。
 *
 * 铁律：模型只允许产出以下 5 类「建议」，每条必须带 reason；
 * 端点 node id 必须是文档里真实存在的 id（由调用方传入 knownNodeIds）。
 * 非法条目**静默丢弃**并在 errors 里计数说明；合法条目录用。
 *
 * 注意：本模块的联合类型刻意用 `kind`  discriminator（而非 store/adapters.ts
 * 里宽松的 `AISuggestion`），因为要承载 group/split/summarize 的额外载荷。
 * store/adapters.ts 的 `AISuggestion` 是 P1 早期预留形态，Wave4 由集成方
 * 把接线指向本模块。
 */

/** 5 类可建议动作。 */
export const AI_TASK_KINDS = [
  'add-edge',
  'set-root',
  'group',
  'split-block',
  'summarize',
] as const;
export type AiSuggestionKind = (typeof AI_TASK_KINDS)[number];

/** 用户可触发的 5 类任务（与 kind 大致对应，organize 是综合整理）。 */
export const AI_TASKS = ['organize', 'split', 'group', 'summarize', 'gaps'] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** 校验通过后的结构化建议（判别联合）。 */
export type AiSuggestion =
  | {
      kind: 'add-edge';
      reason: string;
      source: string;
      target: string;
      label?: string;
    }
  | { kind: 'set-root'; reason: string; rootNodeId: string }
  | { kind: 'group'; reason: string; memberNodeIds: string[]; title?: string }
  | {
      kind: 'split-block';
      reason: string;
      targetNodeId: string;
      /** 新建兄弟块承载的段落文本。 */
      afterText: string;
    }
  | { kind: 'summarize'; reason: string; targetNodeId: string; newText: string };

// ---------- zod 原始输入形状（模型实际吐的 JSON） ----------

const addEdgeRaw = z.object({
  kind: z.literal('add-edge'),
  reason: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  label: z.string().optional(),
});

const setRootRaw = z.object({
  kind: z.literal('set-root'),
  reason: z.string().min(1),
  rootNodeId: z.string().min(1),
});

const groupRaw = z.object({
  kind: z.literal('group'),
  reason: z.string().min(1),
  memberNodeIds: z.array(z.string().min(1)).min(2),
  title: z.string().optional(),
});

const splitRaw = z.object({
  kind: z.literal('split-block'),
  reason: z.string().min(1),
  targetNodeId: z.string().min(1),
  afterText: z.string().min(1),
});

const summarizeRaw = z.object({
  kind: z.literal('summarize'),
  reason: z.string().min(1),
  targetNodeId: z.string().min(1),
  newText: z.string().min(1),
});

const suggestionRaw = z.discriminatedUnion('kind', [
  addEdgeRaw,
  setRootRaw,
  groupRaw,
  splitRaw,
  summarizeRaw,
]);

/** validateAiOutput 的返回。ok:true 时即便有丢弃条目也会在 errors 里计数。 */
export type AiValidationResult =
  | { ok: true; suggestions: AiSuggestion[]; errors: string[] }
  | { ok: false; errors: string[] };

/**
 * 校验模型原始输出。
 * @param raw           模型返回的 JSON（可能是任意形态，含 ```json 包裹已由调用方剥离）
 * @param knownNodeIds  文档里真实存在的 node id 集合（端点合法性）
 */
export function validateAiOutput(raw: unknown, knownNodeIds: ReadonlySet<string>): AiValidationResult {
  const errors: string[] = [];

  // 顶层必须是对象数组（或包在 { suggestions: [...] } 里）。
  let list: unknown = raw;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const maybe = (raw as { suggestions?: unknown }).suggestions;
    if (Array.isArray(maybe)) list = maybe;
  }
  if (!Array.isArray(list)) {
    return { ok: false, errors: ['模型输出不是 JSON 数组，无法解析为建议列表。'] };
  }

  const out: AiSuggestion[] = [];
  list.forEach((item, idx) => {
    const parsed = suggestionRaw.safeParse(item);
    if (!parsed.success) {
      errors.push(`第 ${idx + 1} 条建议字段不合法，已丢弃。`);
      return;
    }
    const s = parsed.data;
    // 端点 id 合法性检查。
    const ids: string[] =
      s.kind === 'add-edge'
        ? [s.source, s.target]
        : s.kind === 'set-root'
          ? [s.rootNodeId]
          : s.kind === 'group'
            ? s.memberNodeIds
            : [s.targetNodeId];
    const bad = ids.filter((id) => !knownNodeIds.has(id));
    if (bad.length > 0) {
      errors.push(`第 ${idx + 1} 条建议引用了不存在的节点 [${bad.join(', ')}]，已丢弃。`);
      return;
    }
    if (s.kind === 'add-edge' && s.source === s.target) {
      errors.push(`第 ${idx + 1} 条建议自环（source===target），已丢弃。`);
      return;
    }
    out.push(s as AiSuggestion);
  });

  if (out.length === 0) {
    return { ok: false, errors: errors.length > 0 ? errors : ['模型未给出任何合法建议。'] };
  }
  return { ok: true, suggestions: out, errors };
}
