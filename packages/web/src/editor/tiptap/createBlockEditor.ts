import { Editor, Extension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import TextStyle from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { lowlight } from './highlight';
import { buildMarkdownInputRules } from './input-rules';

/**
 * 自研扩展：把 §4.2 的 Markdown 行首快捷规则挂进 inputRules。
 */
const MarkdownInputRules = Extension.create({
  name: 'markdownInputRules',
  addInputRules() {
    return buildMarkdownInputRules(this.editor);
  },
});

export interface CreateBlockEditorOptions {
  /** Tiptap JSON doc（BlockContent.data）。 */
  content: unknown;
  /** 占位文本。 */
  placeholder?: string;
  /** 内容变更回调（提交 Tiptap JSON）。 */
  onUpdate?: (json: unknown) => void;
  editable?: boolean;
  autofocus?: boolean | 'start' | 'end' | number;
}

/**
 * createBlockEditor —— 统一块编辑器工厂。
 * 扩展面：StarterKit（h1-3 / bold / italic / strike / code / 列表 / quote / hr）
 *   + Underline + Highlight(多色) + TextStyle + Color + Link(autolink, Cmd+K)
 *   + Placeholder + Image + TaskList/TaskItem。
 */
export function createBlockEditor(opts: CreateBlockEditorOptions): Editor {
  return new Editor({
    content: opts.content as object,
    editable: opts.editable ?? true,
    autofocus: opts.autofocus ?? false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // 用 CodeBlockLowlight 替代内置 codeBlock（否则重名覆盖，无 hljs）
        codeBlock: false,
        // history 在块级编辑器里保留（块内 undo）；画布级 undo 走 EditorApi。
      }),
      Underline,
      Highlight.configure({ multicolor: true }),
      TextStyle,
      Color,
      Link.configure({
        autolink: true,
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      Placeholder.configure({
        placeholder: opts.placeholder ?? "输入 / 唤起菜单，或直接打字…",
      }),
      Image,
      TaskList,
      TaskItem.configure({ nested: true }),
      MarkdownInputRules,
      // P1：表格（可编辑，Tab 跳格走 Tiptap 自带 handleTabNext/Prev）
      Table.configure({ resizable: false, HTMLAttributes: { class: 'drawpaper-table' } }),
      TableRow,
      TableHeader,
      TableCell,
      // P1：代码块 + lowlight 语法高亮
      CodeBlockLowlight.configure({ lowlight }),
    ],
    onUpdate: ({ editor }) => {
      opts.onUpdate?.(editor.getJSON());
    },
  });
}

let _staticExts: readonly unknown[] | null = null;

/**
 * 静态渲染用的扩展列表（不创建 Editor 实例；generateHTML 纯渲染）。
 * 非编辑态节点一律走这条路径（500 块帧率关键）。
 */
export function getStaticExtensions(): readonly unknown[] {
  if (_staticExts) return _staticExts;
  _staticExts = [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: false }),
    Underline,
    Highlight.configure({ multicolor: true }),
    TextStyle,
    Color,
    Image,
    TaskList,
    TaskItem.configure({ nested: true }),
    // P1 静态渲染同样需要 table / codeBlock 扩展，才能输出 <table> 与 hljs class。
    Table.configure({ resizable: false, HTMLAttributes: { class: 'drawpaper-table' } }),
    TableRow,
    TableHeader,
    TableCell,
    CodeBlockLowlight.configure({ lowlight }),
  ];
  return _staticExts;
}
