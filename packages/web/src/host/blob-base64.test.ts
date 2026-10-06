import { describe, expect, it } from 'vitest';
import { blobToBase64 } from './blob-base64';

/**
 * Wave13：Blob→base64 纯函数单测。
 *  - 小文本往返与 atob 解回一致；
 *  - 大 Blob（>32KB 分块边界）也能正确编码（btoa 一次性吃整段会栈溢出）。
 */
describe('blobToBase64', () => {
  it('把文本 Blob 编码为标准 base64（atob 可解回）', async () => {
    const blob = new Blob(['hello drawpaper'], { type: 'text/plain' });
    const b64 = await blobToBase64(blob);
    expect(b64).toBe(btoa('hello drawpaper'));
    expect(atob(b64)).toBe('hello drawpaper');
  });

  it('空 Blob → 空字符串', async () => {
    expect(await blobToBase64(new Blob([]))).toBe('');
  });

  it('跨 32KB 分块边界仍正确编码', async () => {
    // 构造 100KB 的 'A' 串，强制走分块循环。
    const text = 'A'.repeat(100_000);
    const blob = new Blob([text]);
    const b64 = await blobToBase64(blob);
    // 与浏览器原生 btoa(整段) 结果一致。
    expect(b64).toBe(btoa(text));
    expect(b64.length).toBeGreaterThan(130_000);
  });
});
