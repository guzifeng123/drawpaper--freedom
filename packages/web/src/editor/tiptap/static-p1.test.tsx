import { describe, expect, it } from 'vitest';
import { tiptapJsonToHtml } from './static';
import { renderEquation, stripDollars } from './katex-html';
import { setCodeLanguage, readCodeLanguage } from './code-ops';
import { codeToHtml, extractCodeText } from './highlight';
import { filterSlashItems } from './slash-menu';

describe('P1 静态渲染（SSR，不挂编辑器实例）', () => {
  it('代码块 codeToHtml 输出带 hljs token class', () => {
    const html = codeToHtml('const a = 1', 'js');
    expect(html).toContain('hljs');
    expect(html).toContain('language-js');
  });

  it('extractCodeText 从 codeBlock doc 抽源码', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'const a = 1' }] }],
    };
    expect(extractCodeText(doc)).toBe('const a = 1');
  });

  it('表格输出 <table> 与表头', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'H' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'C' }] }] },
              ],
            },
          ],
        },
      ],
    };
    const html = tiptapJsonToHtml(doc);
    expect(html).toContain('<table');
    expect(html).toContain('<th');
  });

  it('KaTeX 渲染输出 katex class，且字体本地（无 CDN/外网字体引用）', () => {
    const html = renderEquation('E = mc^2');
    expect(html).toContain('katex');
    // 注意：MathML 命名空间 http://www.w3.org/... 不是网络请求；只禁止 CDN 字体外链
    expect(html).not.toContain('fonts.googleapis');
    expect(html).not.toContain('cdn');
  });

  it('KaTeX 渲染失败不抛异常，输出错误标记', () => {
    const html = renderEquation('\\unknowncommand{');
    // throwOnError:false → 仍输出 katex-error 或 katex 结构，不抛
    expect(html.length).toBeGreaterThan(0);
  });

  it('stripDollars 剥离 $...$', () => {
    expect(stripDollars('$E=mc^2$')).toBe('E=mc^2');
    expect(stripDollars('E=mc^2')).toBe('E=mc^2');
  });
});

describe('code-ops', () => {
  it('setCodeLanguage 改语言并可回读', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'x' }] }],
    };
    const next = setCodeLanguage(doc, 'python');
    expect(readCodeLanguage(next)).toBe('python');
    // 不改原对象
    expect(readCodeLanguage(doc)).toBe('js');
  });
});

describe('斜杠菜单接入 P1 块型', () => {
  it('包含表格/代码/公式/书签/附件/提醒', () => {
    const ids = filterSlashItems('').map((i) => i.id);
    for (const want of ['table', 'code', 'equation', 'bookmark', 'attachment', 'reminder']) {
      expect(ids).toContain(want);
    }
  });

  it('按「代码」过滤命中代码块', () => {
    expect(filterSlashItems('代码').some((i) => i.id === 'code')).toBe(true);
  });
});
