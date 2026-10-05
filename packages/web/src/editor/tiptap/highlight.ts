/**
 * highlight.ts —— 语法高亮统一入口（轻量壳，懒加载重型模块）。
 *
 * 只保留无依赖的纯数据/纯函数：语言下拉选项、代码文本抽取、加载器。
 * 重型 hljs + 11 语言 + lowlight 在 highlight-data.ts，由 ensureHighlighter() 动态 import，
 * 代码块首次渲染/编辑时才加载，不进首包。
 *
 * 高亮 CSS 主题见 editor/css/editor-theme.css（CSS 变量适配深色）。
 */

import type { lowlight as LowlightType } from './highlight-data';

export interface Highlighter {
  lowlight: typeof LowlightType;
  codeToHtml: (code: string, language?: string) => string;
}

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighterLoaded: Highlighter | null = null;

/** 动态加载重型高亮模块（hljs + lowlight），全程只加载一次。 */
export function ensureHighlighter(): Promise<Highlighter> {
  if (highlighterLoaded) return Promise.resolve(highlighterLoaded);
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = (async () => {
    const mod = await import('./highlight-data');
    highlighterLoaded = { lowlight: mod.lowlight, codeToHtml: mod.codeToHtml };
    return highlighterLoaded;
  })();
  return highlighterPromise;
}

/** 代码块语言下拉选项（P1 常用集）。 */
export const CODE_LANGUAGES: readonly { value: string; label: string }[] = [
  { value: 'js', label: 'JavaScript' },
  { value: 'ts', label: 'TypeScript' },
  { value: 'json', label: 'JSON' },
  { value: 'python', label: 'Python' },
  { value: 'rust', label: 'Rust' },
  { value: 'go', label: 'Go' },
  { value: 'java', label: 'Java' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'bash', label: 'Bash' },
  { value: 'yaml', label: 'YAML' },
];

/** 同步渲染：要求 highlighter 已通过 ensureHighlighter() 加载；未加载时抛错。 */
export function codeToHtml(code: string, language?: string): string {
  if (!highlighterLoaded) {
    throw new Error('[drawpaper] highlighter not loaded. Await ensureHighlighter() before codeToHtml().');
  }
  return highlighterLoaded.codeToHtml(code, language);
}

/** 异步渲染：先确保高亮模块加载完成，再同步渲染。 */
export async function codeToHtmlAsync(code: string, language?: string): Promise<string> {
  await ensureHighlighter();
  return codeToHtml(code, language);
}

/** 从 Tiptap codeBlock PM doc 抽取纯代码文本。 */
export function extractCodeText(data: unknown): string {
  let out = '';
  type NodeLike = { type?: string; text?: string; content?: unknown[] };
  const inner = (node: NodeLike): void => {
    if (typeof node.text === 'string') out += node.text;
    if (Array.isArray(node.content)) node.content.forEach((c) => inner(c as NodeLike));
  };
  const walk = (n: NodeLike): void => {
    if (n.type === 'codeBlock') {
      inner(n);
      return;
    }
    if (Array.isArray(n.content)) n.content.forEach((c) => walk(c as NodeLike));
  };
  walk(data as NodeLike);
  return out;
}
