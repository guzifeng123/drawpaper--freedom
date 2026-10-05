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
import type { lowlight } from './highlight';

type LowlightInstance = typeof lowlight;

/**
 * highlight-data.ts —— 重型语法高亮模块（懒加载 chunk）。
 *
 * 只装 P1 常用的 11 种语言语法。由 highlight.ts 的 ensureHighlighter() 动态 import，
 * 代码块首次渲染/编辑前不进首包。加载后把语言 register 进共享 lowlight 单例。
 */

const GRAMMARS = {
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
} as const;

// hljs 自身注册（供 codeToHtml 静态 SSR 渲染用）。
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

/** 把 11 种语言注册进共享 lowlight 单例（live 编辑装饰用）。 */
export function registerGrammars(lowlight: LowlightInstance): void {
  lowlight.register(GRAMMARS);
}

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
