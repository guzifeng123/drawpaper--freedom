import { describe, expect, it } from 'vitest';
import type { Editor } from '@tiptap/react';
import { CellSelection, mergeCells, splitCell } from '@tiptap/pm/tables';
import { createBlockEditor } from './createBlockEditor';

/**
 * 表格合并/拆分命令层单测（e2e 无法稳定自动化 ProseMirror 单元格拖选）。
 * 用 CellSelection 程序化选中相邻两格 → mergeCells 断言 colspan=2 → splitCell 还原。
 *
 * 注意：合并/拆分命令作用于 CellSelection；链上不能先 .focus()（会折叠选区），
 * 因此这里直接通过 editor.commands 在当前选区上执行（与工具条按钮一致）。
 */
const cell = (text: string) => ({
  type: 'tableCell',
  attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null },
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function makeEditor(): Editor {
  return createBlockEditor({
    content: {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [cell('a'), cell('b')] },
            { type: 'tableRow', content: [cell('c'), cell('d')] },
          ],
        },
      ],
    },
  });
}

/** 选中第 row 行第 colA..colB 两列，返回 CellSelection。 */
function selectRowCells(ed: Editor, row: number): void {
  
  const cells: number[] = [];
  ed.state.doc.descendants((n, pos) => {
    if (n.type.name === 'tableCell') cells.push(pos);
    return true;
  });
  const base = row * 2;
  const sel = new CellSelection(ed.state.doc.resolve(cells[base]!), ed.state.doc.resolve(cells[base + 1]!));
  ed.view.dispatch(ed.state.tr.setSelection(sel));
}

describe('表格合并/拆分（命令层）', () => {
  it('默认两格均为 colspan=1', () => {
    const ed = makeEditor();
    expect(ed.getHTML()).toContain('<td');
    expect(ed.getHTML()).not.toContain('colspan="2"');
    ed.destroy();
  });

  it('普通光标下 mergeCells 不可用；CellSelection 下可用', () => {
    const ed = makeEditor();
    
    // 普通光标：mergeCells 命令返回 false
    expect(mergeCells(ed.state, undefined)).toBe(false);
    selectRowCells(ed, 0);
    // CellSelection 跨两格：命令可用
    expect(mergeCells(ed.state, undefined)).toBe(true);
    ed.destroy();
  });

  it('mergeCells 产生 colspan=2，splitCell 还原', () => {
    const ed = makeEditor();
    
    selectRowCells(ed, 0);
    // 在 CellSelection 上直接 dispatch（与工具条按钮同命令；不在链上 .focus 以免折叠选区）。
    mergeCells(ed.state, (tr) => ed.view.dispatch(tr));
    expect(ed.getHTML()).toContain('colspan="2"');
    // 合并后光标落在合并格，splitCell 可用
    expect(splitCell(ed.state, undefined)).toBe(true);
    splitCell(ed.state, (tr) => ed.view.dispatch(tr));
    expect(ed.getHTML()).not.toContain('colspan="2"');
    ed.destroy();
  });
});
