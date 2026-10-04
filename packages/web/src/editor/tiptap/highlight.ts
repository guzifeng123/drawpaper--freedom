import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import { createLowlight } from 'lowlight';

/**
 * highlight.ts —— 统一语法高亮（代码块）。
 *
 * 只注册 P1 常用的 11 种语言（而非全量 common），控制主包体积。
 * - live 编辑：lowlight（CodeBlockLowlight 装饰）。
 * - 静态 SSR：Tiptap 的 generateHTML 不跑装饰插件，故直接用 highlight.js
 *   产出带 `hljs-*` token class 的 HTML 字符串（500 块帧率关键）。
 * 高亮 CSS 主题见 editor/css/editor-theme.css（CSS 变量适配深色）。
 */
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('yaml', yaml);

/** 与 hljs 同一批语言，供 CodeBlockLowlight live 高亮。 */
export const lowlight = createLowlight({
  js: javascript,
  ts: typescript,
  json,
  python,
  rust,
  go,
  java,
  html: xml,
  css,
  bash,
  yaml,
});

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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 把代码字符串高亮成 `<pre class="hljs language-x"><code>…token spans…</code></pre>` HTML。
 * 未知语言/失败时退化为转义纯文本。
 */
export function codeToHtml(code: string, language?: string): string {
  const lang = language && hljs.getLanguage(language) ? language : undefined;
  let inner: string;
  if (lang) {
    try {
      inner = hljs.highlight(code, { language: lang }).value;
    } catch {
      inner = escapeHtml(code);
    }
  } else {
    inner = escapeHtml(code);
  }
  const cls = lang ? `hljs language-${lang}` : 'hljs';
  return `<pre class="${cls}"><code>${inner}</code></pre>`;
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
