/**
 * 本地 AI 配置（仅存浏览器 localStorage，不上传、不遥测）。
 * 用户自带 endpoint + key；预设各厂商的 OpenAI 兼容端点作为占位/帮助文案。
 */

export interface AiConfig {
  /** OpenAI 兼容 base URL（如 https://api.openai.com/v1）。 */
  endpoint: string;
  apiKey: string;
  model: string;
  temperature: number;
}

const KEY = 'drawpaper.ai.config.v1';

/** 各厂商 OpenAI 兼容端点预设（仅占位帮助，不内置 key）。 */
export const ENDPOINT_PRESETS: ReadonlyArray<{ name: string; endpoint: string; model: string }> = [
  { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: '豆包 (Doubao)', endpoint: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' },
  { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: '通义 (Qwen)', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'Kimi (Moonshot)', endpoint: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
];

export const DEFAULT_CONFIG: AiConfig = {
  endpoint: '',
  apiKey: '',
  model: '',
  temperature: 0.2,
};

export function loadAiConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    return {
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : '',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      temperature:
        typeof parsed.temperature === 'number' && Number.isFinite(parsed.temperature)
          ? parsed.temperature
          : 0.2,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveAiConfig(cfg: AiConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    // 隐私模式 / 配额：静默忽略（本会话仍可内存态使用）。
  }
}
