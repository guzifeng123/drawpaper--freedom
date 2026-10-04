import { describe, it, expect } from 'vitest';
import { tiptapToMarkdown } from './tiptap-to-markdown';

describe('tiptapToMarkdown 各块型', () => {
  it('标题层级', () => {
    const md = tiptapToMarkdown({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '标题一' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '标题三' }] },
      ],
    });
    expect(md).toContain('# 标题一');
    expect(md).toContain('### 标题三');
  });

  it('段落与行内 marks', () => {
    const md = tiptapToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '粗体', marks: [{ type: 'bold' }] },
            { type: 'text', text: '和' },
            { type: 'text', text: '链接', marks: [{ type: 'link', attrs: { href: 'https://x' } }] },
          ],
        },
      ],
    });
    expect(md).toContain('**粗体**');
    expect(md).toContain('[链接](https://x)');
  });

  it('待办转 - [ ]/[x]', () => {
    const md = tiptapToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '未完成' }] }] },
            { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '已完成' }] }] },
          ],
        },
      ],
    });
    expect(md).toContain('- [ ] 未完成');
    expect(md).toContain('- [x] 已完成');
  });

  it('bulletList 转 -，引用块转 >', () => {
    const md = tiptapToMarkdown({
      type: 'doc',
      content: [
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '要点' }] }] }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: '引用' }] }] },
      ],
    });
    expect(md).toContain('- 要点');
    expect(md).toContain('> 引用');
  });

  it('代码块与图片占位', () => {
    const md = tiptapToMarkdown({
      type: 'doc',
      content: [
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1' }] },
        { type: 'image', attrs: { src: 'assetref', alt: '图' } },
      ],
    });
    expect(md).toContain('```ts');
    expect(md).toContain('const a = 1');
    expect(md).toContain('![图](assetref)');
  });
});
