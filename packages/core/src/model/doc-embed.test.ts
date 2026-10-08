import { describe, it, expect } from 'vitest';
import { parseDocEmbedData, isDocEmbedData } from './doc-embed.js';

describe('doc-embed payload 宽容解析', () => {
  it('合法 payload 归一化通过', () => {
    const d = parseDocEmbedData({
      kind: 'doc-embed',
      targetDocId: 'docB',
      targetNodeId: 'n2',
      titleSnapshot: '目标块',
    });
    expect(d).toEqual({ kind: 'doc-embed', targetDocId: 'docB', targetNodeId: 'n2', titleSnapshot: '目标块' });
    expect(isDocEmbedData(d)).toBe(true);
  });

  it('未知 kind → null（宽容，不抛）', () => {
    expect(parseDocEmbedData({ kind: 'bookmark', url: 'x' })).toBeNull();
    expect(parseDocEmbedData({ kind: 'something-else', targetDocId: 'a', targetNodeId: 'b' })).toBeNull();
  });

  it('畸形 payload（缺 id / 空串 / 非对象）→ null', () => {
    expect(parseDocEmbedData(null)).toBeNull();
    expect(parseDocEmbedData(undefined)).toBeNull();
    expect(parseDocEmbedData('doc')).toBeNull();
    expect(parseDocEmbedData({ kind: 'doc-embed' })).toBeNull();
    expect(parseDocEmbedData({ kind: 'doc-embed', targetDocId: '', targetNodeId: 'n1' })).toBeNull();
    expect(parseDocEmbedData({ kind: 'doc-embed', targetDocId: 'd', targetNodeId: 123 })).toBeNull();
    expect(parseDocEmbedData([1, 2])).toBeNull();
  });

  it('titleSnapshot 缺省/非字符串 → 空串，不丢引用', () => {
    const d = parseDocEmbedData({ kind: 'doc-embed', targetDocId: 'd', targetNodeId: 'n' });
    expect(d?.titleSnapshot).toBe('');
    const d2 = parseDocEmbedData({ kind: 'doc-embed', targetDocId: 'd', targetNodeId: 'n', titleSnapshot: 42 });
    expect(d2?.titleSnapshot).toBe('');
  });

  it('附带额外字段不影响判别（附加式前向兼容）', () => {
    const d = parseDocEmbedData({
      kind: 'doc-embed',
      targetDocId: 'd',
      targetNodeId: 'n',
      titleSnapshot: 't',
      futureField: '随便',
    });
    expect(d?.targetNodeId).toBe('n');
  });
});
