import { textblockTypeInputRule, wrappingInputRule, getSchemaTypeByName } from '@tiptap/react';
import type { Editor } from '@tiptap/react';

/**
 * Markdown 行首快捷输入规则（自研，基于 ProseMirror inputRules）：
 *   `# ` → h1，`## ` → h2，`### ` → h3
 *   `- `/`* ` → 无序列表，`1. ` → 有序列表
 *   `[] `/`[ ] `/`[x] ` → 待办
 *   `> ` → 引用，`--- ` → 分隔线
 *
 * 用法：createBlockEditor 组装 extensions 时把这些规则并入各扩展的 inputRules。
 */
export function buildMarkdownInputRules(editor: Editor): Array<ReturnType<typeof textblockTypeInputRule>> {
  const rules: Array<ReturnType<typeof textblockTypeInputRule>> = [];
  const schema = editor.schema;

  const heading = (getSchemaTypeByName('heading', schema) as import('@tiptap/pm/model').NodeType | undefined);
  if (heading) {
    rules.push(
      textblockTypeInputRule({ find: /^# $/, type: heading, getAttributes: { level: 1 } }),
      textblockTypeInputRule({ find: /^## $/, type: heading, getAttributes: { level: 2 } }),
      textblockTypeInputRule({ find: /^### $/, type: heading, getAttributes: { level: 3 } }),
    );
  }

  const bulletList = (getSchemaTypeByName('bulletList', schema) as import('@tiptap/pm/model').NodeType | undefined);
  if (bulletList) {
    rules.push(wrappingInputRule({ find: /^[-*] $/, type: bulletList }));
  }

  const orderedList = (getSchemaTypeByName('orderedList', schema) as import('@tiptap/pm/model').NodeType | undefined);
  if (orderedList) {
    rules.push(wrappingInputRule({ find: /^(\d+)\. $/, type: orderedList }));
  }

  const taskList = (getSchemaTypeByName('taskList', schema) as import('@tiptap/pm/model').NodeType | undefined);
  if (taskList) {
    rules.push(
      wrappingInputRule({
        find: /^\[( |x|X)?\] $/,
        type: taskList,
        getAttributes: (match) => ({ checked: (match[1] ?? '').toLowerCase() === 'x' }),
      }),
    );
  }

  const blockquote = (getSchemaTypeByName('blockquote', schema) as import('@tiptap/pm/model').NodeType | undefined);
  if (blockquote) {
    rules.push(wrappingInputRule({ find: /^> $/, type: blockquote }));
  }

  const horizontalRule = (getSchemaTypeByName('horizontalRule', schema) as import('@tiptap/pm/model').NodeType | undefined);
  if (horizontalRule) {
    rules.push(textblockTypeInputRule({ find: /^--- $/, type: horizontalRule }));
  }

  return rules;
}

/** 纯规则匹配测试用：输入一行文本，返回它命中的规则名（不操作 Editor）。 */
export type MarkdownRuleName = 'h1' | 'h2' | 'h3' | 'bullet' | 'ordered' | 'todo' | 'quote' | 'hr';

export function matchMarkdownRule(line: string): MarkdownRuleName | null {
  const re: Array<[RegExp, MarkdownRuleName]> = [
    [/^### $/, 'h3'],
    [/^## $/, 'h2'],
    [/^# $/, 'h1'],
    [/^[-*] $/, 'bullet'],
    [/^\d+\. $/, 'ordered'],
    [/^\[( |x|X)?\] $/, 'todo'],
    [/^> $/, 'quote'],
    [/^--- $/, 'hr'],
  ];
  for (const [r, name] of re) {
    if (r.test(line)) return name;
  }
  return null;
}
