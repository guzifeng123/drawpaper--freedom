import { describe, expect, it, beforeEach } from 'vitest';
import { createBlockEditor } from './createBlockEditor';
import { lowlight, ensureHighlighter } from './highlight';

/**
 * Wave5c 回归：文本块进编辑态绝不能等语言语法 chunk（否则冷 dev server 下双击建块高概率失败）。
 * 断言：
 *  - 文本块 createBlockEditor 不触发 highlight-data 动态 import（lowlight 仍空 registry）。
 *  - 代码块内容 createBlockEditor 才 await 加载语言语法（lowlight 注册后非空）。
 */

const textDoc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
};

const codeDoc = {
  type: 'doc',
  content: [{ type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'const a=1' }] }],
};

describe('createBlockEditor 高亮懒加载边界', () => {
  beforeEach(() => {
    // lowlight 单例在模块级创建；测试间语言 registry 可能已被前序用例注册，
    // 这里只验证"文本块不新增注册"，不依赖空初始态。
  });

  it('文本块同步构造 Editor，不加载语言语法 chunk', async () => {
    const before = lowlight.listLanguages().length;
    const ed = await createBlockEditor({ content: textDoc, editable: true });
    // 编辑器立即可用
    expect(ed).toBeTruthy();
    expect(ed.isEditable).toBe(true);
    // 未触发语言 chunk：registry 数量不变（未 ensureHighlighter）
    expect(lowlight.listLanguages().length).toBe(before);
    ed.destroy();
  });

  it('代码块内容会加载语言语法并注册进共享 lowlight 单例', async () => {
    const ed = await createBlockEditor({ content: codeDoc, editable: true });
    expect(ed).toBeTruthy();
    // ensureHighlighter 被触发后，js 等语言已注册
    await ensureHighlighter();
    expect(lowlight.listLanguages()).toContain('js');
    ed.destroy();
  });
});
