import { describe, expect, it } from 'vitest';
import { classifyFile, dropOffset } from './drop-classify';

describe('drop-classify', () => {
  it('文本扩展名 → text', () => {
    expect(classifyFile('a.txt', 'text/plain')).toBe('text');
    expect(classifyFile('README.MD', 'text/markdown')).toBe('text');
    expect(classifyFile('note.markdown', '')).toBe('text');
  });

  it('图片 → image（按 mime 或扩展名）', () => {
    expect(classifyFile('a.png', 'image/png')).toBe('image');
    expect(classifyFile('photo.jpg', '')).toBe('image');
    expect(classifyFile('x.svg', 'image/svg+xml')).toBe('image');
  });

  it('其他已知类型 → attachment', () => {
    expect(classifyFile('plan.pdf', 'application/pdf')).toBe('attachment');
    expect(classifyFile('data.zip', '')).toBe('attachment');
  });

  it('无扩展名 → unsupported', () => {
    expect(classifyFile('Makefile', '')).toBe('unsupported');
  });

  it('dropOffset 多文件错位', () => {
    expect(dropOffset(0)).toEqual({ dx: 0, dy: 0 });
    expect(dropOffset(1)).toEqual({ dx: 24, dy: 24 });
  });
});
