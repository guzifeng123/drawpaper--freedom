import katex from 'katex';
// KaTeX 字体/样式本地打包（Vite 解析相对 url(fonts/...)，禁止 CDN）。
import 'katex/dist/katex.min.css';

/**
 * katex-html.ts —— 公式块静态渲染（SSR 字符串，不创建编辑器实例）。
 *
 * - 输入 $...$ 语法的源码：自动剥离首尾 $。
 * - throwOnError=false：渲染失败时输出红色错误原文（不抛异常、不白屏）。
 * - 结果带 `.katex` / `.katex-token` 类，CSS 主题在 editor/css/editor-theme.css。
 */

let cache = new Map<string, string>();

/** 剥离包裹的 $...$ / $$...$$。 */
export function stripDollars(source: string): string {
  let s = source.trim();
  if (s.startsWith('$$') && s.endsWith('$$') && s.length >= 4) s = s.slice(2, -2);
  else if (s.startsWith('$') && s.endsWith('$') && s.length >= 2) s = s.slice(1, -1);
  return s.trim();
}

export function renderEquation(source: string): string {
  const src = stripDollars(source);
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = katex.renderToString(src, {
      throwOnError: false,
      displayMode: true,
      errorColor: '#e11d48',
    });
  } catch {
    // throwOnError:false 时一般不抛；兜底显示原文
    html = `<span class="katex-error" style="color:#e11d48">${escapeHtml(src)}</span>`;
  }
  if (cache.size > 500) cache = new Map();
  cache.set(src, html);
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
