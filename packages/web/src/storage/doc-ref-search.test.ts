import { describe, it, expect } from 'vitest';
import { createNode } from '@drawpaper/core';
import { nodeDisplayTitle } from './doc-ref-search';

function paraNode(text: string) {
  const n = createNode('text', 0, 0, {
    content: { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } },
  });
  return n;
}

describe('nodeDisplayTitle', () => {
  it('取正文前 18 字，超长截断加省略号', () => {
    expect(nodeDisplayTitle(paraNode('开会讨论方案'))).toBe('开会讨论方案');
    const long = '一二三四五六七八九十一二三四五六七八九十'; // 20 字（>18 才触发截断）
    const t = nodeDisplayTitle(paraNode(long));
    expect(t.length).toBeLessThanOrEqual(19);
    expect(t.endsWith('…')).toBe(true);
  });

  it('空块显示「空块」', () => {
    expect(nodeDisplayTitle(createNode('text', 0, 0))).toBe('空块');
  });
});
