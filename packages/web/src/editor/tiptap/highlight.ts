/**
 * highlight.ts —— 语法高亮统一入口。
 *
 * 分层（Wave5c 回归修复）：
 *  - lowlight **核心**（createLowlight 本体，很小）静态 import，同步创建一个**真实但空的**
 *    lowlight 单例：能通过 CodeBlockLowlight 扩展校验，未注册语言时 highlight() 退化为纯文本。
 *  - 11 种语言语法（hljs + grammar，重量部分 ~88KB）在 highlight-data.ts 懒加载 chunk，
 *    ensureHighlighter() 加载后把语言 register 进**同一个单例**（lowlight 支持创建后注册）。
 *
 * 这样：文本块双击进编辑态不再等任何网络 chunk（同步拿空 lowlight 构造 Editor 即获焦）；
 * 仅代码块路径 await ensureHighlighter() 拿全量语言。
 *
 * 高亮 CSS 主题见 editor/css/editor-theme.css（CSS 变量适配深色）。
 */

import { createLowlight } from 'lowlight';

/** 共享 lowlight 单例：启动即存在（空 registry），语言语法后续动态注册进来。 */
export const lowlight = createLowlight();

export interface Highlighter {
  lowlight: typeof lowlight;
  codeToHtml: (code: string, language?: string) => string;
}

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighterLoaded: Highlighter | null = null;

/** 动态加载重型高亮 chunk（hljs + 11 语言），把语言 register 进共享单例，全程只加载一次。 */
export function ensureHighlighter(): Promise<Highlighter> {
  if (highlighterLoaded) return Promise.resolve(highlighterLoaded);
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = (async () => {
    const mod = await import('./highlight-data');
    mod.registerGrammars(lowlight);
    highlighterLoaded = { lowlight, codeToHtml: mod.codeToHtml };
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
