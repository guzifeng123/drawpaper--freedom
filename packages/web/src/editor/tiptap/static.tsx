import { memo, useMemo } from 'react';
import { generateHTML } from '@tiptap/react';
import { getStaticExtensions } from './createBlockEditor';

/**
 * static.tsx —— 非编辑态节点的轻量静态渲染。
 * 不创建 Editor 实例（500 块下保持 30fps 的关键）：
 * 用 generateHTML 把 Tiptap JSON 一次性转成 HTML 字符串并 memo。
 */

let cache = new Map<string, string>();

function stableKey(json: unknown): string {
  try {
    return JSON.stringify(json ?? null);
  } catch {
    return '';
  }
}

export function tiptapJsonToHtml(json: unknown): string {
  const key = stableKey(json);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = generateHTML(json as object, getStaticExtensions() as never) as string;
  if (cache.size > 2000) cache = new Map();
  cache.set(key, html);
  return html;
}

interface StaticHtmlProps {
  json: unknown;
  className?: string;
}

export const StaticHtml = memo(function StaticHtml({ json, className }: StaticHtmlProps) {
  const html = useMemo(() => tiptapJsonToHtml(json), [json]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
});
