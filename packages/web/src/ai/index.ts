// web/ai barrel：UI + provider + client + 本地接口形状。
export { AiPanel } from './AiPanel';
export { AiSettingsDialog } from './AiSettingsDialog';
export { AiDiffDialog } from './AiDiffDialog';
export { OpenAICompatProvider } from './openai-provider';
export { runAiTask, extractJson, type AiClientResult } from './ai-client';
export { loadAiConfig, saveAiConfig, ENDPOINT_PRESETS, type AiConfig } from './ai-settings';
export { createMockAiApi, type AiApi } from './ai-api';
