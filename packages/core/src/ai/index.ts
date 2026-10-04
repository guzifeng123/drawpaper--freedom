// AI 模块 barrel：纯逻辑，零 DOM。
export * from './suggestion-schema.js';
export { extractNodePlainText, buildAiMessages } from './prompts.js';
export { applyAiSuggestions, type ApplyAiResult } from './apply-ai-diff.js';
export { detectAiGaps, type AiGap } from './gap-detect.js';
