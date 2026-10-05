import { Mark, mergeAttributes } from '@tiptap/react';

/**
 * docRef mark：块内 [[双向链接]] 的行内标记。
 * - name: `docRef`
 * - attrs: { targetDocId, targetNodeId, targetTitle }
 * - 渲染为 `<span class="drawpaper-docref">[[标题]]</span>`；
 *   悬挂态（目标已删）由渲染层据 attrs 补 `is-dangling`（红虚边）。
 * core 已冻结契约（model/links.ts）；本文件只做 Tiptap 扩展注册。
 */
export interface DocRefMarkAttrs {
  targetDocId: string;
  targetNodeId: string;
  targetTitle: string;
}

export const DOCREF_MARK_CLASS = 'drawpaper-docref';

export const DocRefMark = Mark.create({
  name: 'docRef',

  addAttributes() {
    return {
      targetDocId: { default: '' },
      targetNodeId: { default: '' },
      targetTitle: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: `span[data-${DOCREF_MARK_CLASS}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        [`data-${DOCREF_MARK_CLASS}`]: '',
        class: DOCREF_MARK_CLASS,
      }),
      0,
    ];
  },
});

/** 模块级点击分发：chip 被点击时回调（Wave7 总装接真实 openDocRef）。 */
type DocRefClickHandler = (attrs: DocRefMarkAttrs) => void;
let clickHandler: DocRefClickHandler | null = null;

export function setDocRefClickHandler(handler: DocRefClickHandler | null): void {
  clickHandler = handler;
}

/** 全局委托：点击 .drawpaper-docref chip 时分发（在挂载期注册一次）。 */
export function installDocRefClickDelegate(): () => void {
  const onClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest(`.${DOCREF_MARK_CLASS}`) as HTMLElement | null;
    if (!el || !clickHandler) return;
    e.preventDefault();
    clickHandler({
      targetDocId: el.getAttribute('targetDocId') ?? '',
      targetNodeId: el.getAttribute('targetNodeId') ?? '',
      targetTitle: el.getAttribute('targetTitle') ?? '',
    });
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
