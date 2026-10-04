import type { AiSuggestion } from '@drawpaper/core';

/**
 * AI / 手动分页符相关的「本地结构型接口」。
 *
 * 这些动作最终由 store（存储 agent 同期实现）落到文档命令栈；
 * 本接口只是 web/ai 层依赖的形状。Wave4 由集成方把真实 store 动作接线进来；
 * 开发/测试期用 createMockAiApi。
 */
export interface AiApi {
  /** 用户勾选确认后，把建议合入文档。 */
  applyAISuggestions(suggestions: AiSuggestion[], accepted: ReadonlySet<number>): Promise<void>;
  /** 在世界坐标 (x,y) 插入一个手动分页符。 */
  addManualPageBreak(b: { id: string; x: number; y: number }): Promise<void>;
  /** 按 id 删除手动分页符。 */
  removePageBreak(id: string): Promise<void>;
}

/** mock：只在内存里记一下，不写文档（供未接线时 UI 调试/测试）。 */
export function createMockAiApi(): AiApi {
  const applied: Array<{ count: number }> = [];
  const breaks: Array<{ id: string; x: number; y: number }> = [];
  return {
    async applyAISuggestions(suggestions, accepted) {
      applied.push({ count: accepted.size });
      void suggestions;
    },
    async addManualPageBreak(b) {
      breaks.push(b);
    },
    async removePageBreak(id) {
      const i = breaks.findIndex((b) => b.id === id);
      if (i >= 0) breaks.splice(i, 1);
    },
  };
}
