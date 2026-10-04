import { describe, it, expect } from 'vitest';
import { safeParseKBNoteDoc } from '@drawpaper/core';
import { TEMPLATE_REGISTRY, TEMPLATE_LIST } from './templates';

describe('模板工厂', () => {
  it('注册了 6 份模板，id 互不相同', () => {
    expect(TEMPLATE_LIST).toHaveLength(6);
    const ids = TEMPLATE_LIST.map((t) => t.id);
    expect(new Set(ids).size).toBe(6);
    expect(Object.keys(TEMPLATE_REGISTRY)).toHaveLength(6);
  });

  it('每份产出的 doc 都通过 parseKBNoteDoc 校验，且 id 互不相同', () => {
    const ids = new Set<string>();
    for (const factory of Object.values(TEMPLATE_REGISTRY)) {
      const doc = factory();
      const result = safeParseKBNoteDoc(doc);
      expect(result.success).toBe(true);
      ids.add(doc.id);
      // 结构完整：至少含一个根标题块与一条父子边
      expect(doc.nodes.length).toBeGreaterThan(1);
      expect(doc.edges.length).toBeGreaterThan(0);
    }
    expect(ids.size).toBe(6);
  });
});
