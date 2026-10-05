/**
 * katex-html.ts —— 公式块静态渲染（SSR 字符串，不创建编辑器实例）。
 *
 * - 输入 $...$ 语法的源码：自动剥离首尾 $。
 * - throwOnError=false：渲染失败时输出红色错误原文（不抛异常、不白屏）。
 * - 结果带 `.katex` / `.katex-token` 类，CSS 主题在 editor/css/editor-theme.css。
 *
 * 懒加载（Wave5c 分包）：katex JS + 字体 CSS 仅在首次渲染公式块时动态 import，
 * 公式块未出现时不进首包。静态渲染与编辑态 / 导出离屏渲染共用同一加载器。
 */

import type katexType from 'katex';

let cache = new Map<string, string>();
let katexPromise: Promise<typeof katexType> | null = null;
let katexLoaded: typeof katexType | null = null;

/** 动态加载 katex（含本地字体 CSS），全程只加载一次。 */
export function ensureKatex(): Promise<typeof katexType> {
  if (katexLoaded) return Promise.resolve(katexLoaded);
  if (katexPromise) return katexPromise;
  katexPromise = (async () => {
    const [{ default: katex }, _css] = await Promise.all([
      import('katex'),
      // KaTeX 字体/样式本地打包（Vite 解析相对 url(fonts/...)，禁止 CDN）。
      import('katex/dist/katex.min.css'),
    ]);
    katexLoaded = katex;
    return katex;
  })();
  return katexPromise;
}

/** 剥离包裹的 $...$ / $$...$$。 */
export function stripDollars(source: string): string {
  let s = source.trim();
  if (s.startsWith('$$') && s.endsWith('$$') && s.length >= 4) s = s.slice(2, -2);
  else if (s.startsWith('$') && s.endsWith('$') && s.length >= 2) s = s.slice(1, -1);
  return s.trim();
}

/** 同步渲染：要求 katex 已通过 ensureKatex() 加载；未加载时抛错。 */
export function renderEquation(source: string): string {
  const src = stripDollars(source);
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  const katex = getLoadedKatex();
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

/** 异步渲染：先确保 katex 加载完成，再同步渲染。 */
export async function renderEquationAsync(source: string): Promise<string> {
  await ensureKatex();
  return renderEquation(source);
}

function getLoadedKatex(): typeof katexType {
  if (!katexLoaded) {
    throw new Error('[drawpaper] katex not loaded. Await ensureKatex() before renderEquation().');
  }
  return katexLoaded;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
