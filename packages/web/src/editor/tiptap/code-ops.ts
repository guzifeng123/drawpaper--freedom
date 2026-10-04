import type { BlockContent } from '@drawpaper/core';

/**
 * code-ops.ts —— 代码块的辅助操作（纯函数，便于单测）。
 * 代码块 content.data 是 Tiptap PM doc，codeBlock 节点 attrs.language 存语言。
 */

/** 在 PM doc 中把 codeBlock 的 language 改为指定值，返回新 doc。 */
export function setCodeLanguage(data: unknown, language: string): unknown {
  const doc = structuredCloneSafe(data) as {
    type?: string;
    attrs?: Record<string, unknown>;
    content?: unknown[];
  };
  const walk = (node: { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }): boolean => {
    if (node.type === 'codeBlock') {
      node.attrs = { ...node.attrs, language };
      return true;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }[]) {
        if (walk(child)) return true;
      }
    }
    return false;
  };
  walk(doc);
  return doc;
}

function structuredCloneSafe<T>(v: T): T {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 读取代码块当前语言（缺省 'js'）。 */
export function readCodeLanguage(content: BlockContent | unknown): string {
  const data = (content as { data?: unknown })?.data ?? content;
  let lang = 'js';
  const walk = (node: { type?: string; attrs?: { language?: string }; content?: unknown[] }): boolean => {
    if (node.type === 'codeBlock') {
      if (node.attrs?.language) lang = node.attrs.language;
      return true;
    }
    if (Array.isArray(node.content)) {
      for (const c of node.content) {
        if (walk(c as { type?: string; attrs?: { language?: string }; content?: unknown[] })) return true;
      }
    }
    return false;
  };
  walk(data as { type?: string; attrs?: { language?: string }; content?: unknown[] });
  return lang;
}
