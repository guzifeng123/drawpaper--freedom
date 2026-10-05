import type { BlockNode } from '@drawpaper/core';

/**
 * 从 BlockNode 的 Tiptap JSON content 抽取纯文本首行（供总览节点标题/搜索）。
 * core 不解析富文本，web 侧递归遍历 ProseMirror doc 树收集 text 节点。
 */
export function extractBlockLabel(node: BlockNode): string {
  const data = node.content?.data as
    | { content?: Array<Record<string, unknown>> }
    | undefined;
  const out: string[] = [];
  const walk = (nodes: Array<Record<string, unknown>>): void => {
    for (const n of nodes) {
      if (typeof n.text === 'string') out.push(n.text);
      if (Array.isArray(n.content)) walk(n.content as Array<Record<string, unknown>>);
    }
  };
  if (data && Array.isArray(data.content)) walk(data.content);
  const text = out.join(' ').trim();
  if (text) return text.length > 40 ? text.slice(0, 40) + '…' : text;
  // 无文本时回退到块类型名
  return node.type;
}
