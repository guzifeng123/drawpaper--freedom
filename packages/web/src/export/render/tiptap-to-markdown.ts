/**
 * Tiptap JSON → Markdown 纯函数（导出大纲用）。
 * 不依赖 @tiptap/*，只做递归遍历；块型尽量映射：
 *  标题→#  段落→文本  bulletList→-  orderedList→1.  taskList→- [ ]/[x]
 *  blockquote→>  code→```  image→占位链接  hardBreak→两空格换行。
 * 行内 marks：bold **、italic *、code `、link [t](url)。
 */

interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
}

function escInline(text: string): string {
  return text.replace(/([\\`*_[\]<>#])/g, '\\$1');
}

function renderInline(node: PMNode): string {
  if (node.type === 'text') {
    let t = node.text ?? '';
    let code = false;
    for (const m of node.marks ?? []) {
      if (m.type === 'code') {
        code = true;
        break;
      }
    }
    if (code) return '`' + t + '`';
    t = escInline(t);
    for (const m of node.marks ?? []) {
      switch (m.type) {
        case 'bold':
          t = `**${t}**`;
          break;
        case 'italic':
          t = `*${t}*`;
          break;
        case 'strike':
          t = `~~${t}~~`;
          break;
        case 'link': {
          const href = typeof m.attrs?.href === 'string' ? m.attrs.href : '';
          t = href ? `[${t}](${href})` : t;
          break;
        }
        default:
          break;
      }
    }
    return t;
  }
  if (node.type === 'hardBreak') return '  \n';
  if (node.type === 'image') {
    const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
    const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
    return src ? `![${alt}](${src})` : '';
  }
  return renderBlock(node, 0).join('\n');
}

/** 把块节点转成 markdown 行数组。depth 为列表缩进层级。 */
export function renderBlock(node: PMNode, depth: number): string[] {
  const pad = '  '.repeat(depth);
  switch (node.type) {
    case 'doc':
      return (node.content ?? []).flatMap((c) => renderBlock(c, 0));
    case 'paragraph': {
      const text = (node.content ?? []).map(renderInline).join('');
      return text.trim() ? [pad + text] : [];
    }
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      const text = (node.content ?? []).map(renderInline).join('');
      return ['#'.repeat(level) + ' ' + text];
    }
    case 'bulletList':
      return (node.content ?? []).flatMap((c) => renderBlock(c, depth));
    case 'listItem':
      return (node.content ?? []).flatMap((c) => {
        if (c.type === 'bulletList' || c.type === 'orderedList' || c.type === 'taskList') {
          return renderBlock(c, depth + 1);
        }
        const text = renderBlock(c, 0).join(' ');
        return [`${pad}- ${text}`];
      });
    case 'orderedList':
      return (node.content ?? []).flatMap((c) => renderBlock(c, depth));
    case 'orderedListItem': {
      const text = (node.content ?? []).map(renderInline).join('');
      return [`${pad}1. ${text}`];
    }
    case 'taskList':
      return (node.content ?? []).flatMap((c) => renderBlock(c, depth));
    case 'taskItem': {
      const checked = Boolean(node.attrs?.checked);
      const inner = (node.content ?? []).map((c) => renderInline(c)).join(' ');
      return [`${pad}- [${checked ? 'x' : ' '}] ${inner}`];
    }
    case 'blockquote': {
      const inner = (node.content ?? []).flatMap((c) => renderBlock(c, 0));
      return inner.map((l) => '> ' + l);
    }
    case 'codeBlock': {
      const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      const code = (node.content ?? []).map((c) => c.text ?? '').join('\n');
      return ['```' + lang, code, '```'];
    }
    case 'horizontalRule':
      return ['---'];
    case 'image': {
      const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
      const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
      return src ? [`![${alt}](${src})`] : [];
    }
    default:
      return (node.content ?? []).flatMap((c) => renderBlock(c, depth));
  }
}

/** 入口：tiptap doc JSON → markdown 字符串。 */
export function tiptapToMarkdown(doc: unknown): string {
  const root = doc as PMNode | undefined;
  if (!root || typeof root !== 'object') return '';
  return renderBlock(root, 0).join('\n').trim() + '\n';
}
