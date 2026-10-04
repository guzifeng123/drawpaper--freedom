import type { EditorStoreApi } from '@drawpaper/core';
import type { AiSuggestion } from '@drawpaper/core/ai';
import type { AiApi } from '@/ai/ai-api';
import { pushToast } from '@/panels/lib/toast';

/**
 * createAiApi —— 把 Wave3-J 的结构型 AiApi 接到真实 store。
 *
 * 形状桥接：core/ai 的 AiSuggestion 用 `kind/source/target/memberNodeIds/...`；
 * 而 store.applyAISuggestions 消费的是 adapters 宽松形状 `type/proposedEdges/nodeIds/text`。
 * 这里逐条翻译后再落库（J §5.1）。
 *
 * - applyAISuggestions → store.applyAISuggestions（一条宏命令整体一次 undo）；
 *   成功后自动 previewLayout()，让用户走规则布局确认落位（J §5.4）。
 * - addManualPageBreak / removePageBreak → store 手动分页符动作。
 */
function toStoreSuggestion(s: AiSuggestion) {
  switch (s.kind) {
    case 'add-edge':
      return {
        type: 'add-edge' as const,
        reason: s.reason,
        proposedEdges: [{ source: s.source, target: s.target, label: s.label }],
      };
    case 'set-root':
      return { type: 'set-root' as const, reason: s.reason, nodeIds: [s.rootNodeId] };
    case 'group':
      return {
        type: 'group' as const,
        reason: s.reason,
        nodeIds: s.memberNodeIds,
        title: s.title,
      };
    case 'split-block':
      return {
        type: 'split-block' as const,
        reason: s.reason,
        nodeIds: [s.targetNodeId],
        afterNodeId: s.targetNodeId,
        text: s.afterText,
      };
    case 'summarize':
      return {
        type: 'summarize' as const,
        reason: s.reason,
        nodeIds: [s.targetNodeId],
        text: s.newText,
      };
  }
}

export function createAiApi(store: EditorStoreApi): AiApi {
  return {
    async applyAISuggestions(suggestions, accepted) {
      const mapped = suggestions.map(toStoreSuggestion);
      store.getState().applyAISuggestions(mapped as unknown as ReadonlyArray<never>, accepted);
      // 合入后自动进入整理预览，用户可一键确认落位（250ms 过渡 + 可撤销）。
      store.getState().previewLayout();
      pushToast('success', `已合入 ${accepted.size} 条建议，可确认整理布局`);
    },
    async addManualPageBreak(b) {
      store.getState().addManualPageBreak(b.id, b.x, b.y);
    },
    async removePageBreak(id) {
      store.getState().removePageBreak(id);
    },
  };
}
