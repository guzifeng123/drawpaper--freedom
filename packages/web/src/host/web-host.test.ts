import { afterEach, describe, expect, it, vi } from 'vitest';

//  mock 掉 fsa：模拟「不支持 File System Access」→ openWithFsa/saveWithFsa 全失败。
vi.mock('../storage/fsa', () => ({
  openWithFsa: vi.fn(() => Promise.resolve(null)),
  saveWithFsa: vi.fn(() => Promise.resolve(false)),
}));

import { WebHostAdapter } from './web-host';
import { openWithFsa, saveWithFsa } from '../storage/fsa';

/**
 * Wave7 robustness：WebHostAdapter 在 FSA 缺失时的 input/anchor 降级路径。
 * Safari/Firefox 无 showSaveFilePicker 时必须落到 <input type=file> / <a download>。
 */
describe('WebHostAdapter 降级路径（无 File System Access）', () => {
  afterEach(() => {
    vi.mocked(openWithFsa).mockResolvedValue(null);
    vi.mocked(saveWithFsa).mockResolvedValue(false);
  });

  it('showOpenFilePicker：FSA 返回 null 后走 <input type=file> 选择并读取文本', async () => {
    const adapter = new WebHostAdapter();
    // 捕获创建的 input 元素。
    let captured: HTMLInputElement | null = null;
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'input') captured = el as HTMLInputElement;
      return el;
    });

    const p = adapter.showOpenFilePicker();
    // 等 input.click() 触发；jsdom 里 click 不做任何事，手动塞文件并触发 onchange。
    await vi.waitFor(() => expect(captured).not.toBeNull());
    const file = new File(['{"v":1}'], 'a.kbnote', { type: 'application/json' });
    // jsdom 未实现 File.text()，桩上。
    (file as unknown as { text: () => Promise<string> }).text = () => Promise.resolve('{"v":1}');
    Object.defineProperty(captured!, 'files', { value: [file], configurable: true });
    captured!.onchange?.(new Event('change'));

    const result = await p;
    expect(result).toEqual({ name: 'a.kbnote', text: '{"v":1}' });
    vi.mocked(document.createElement).mockRestore();
  });

  it('showSaveFilePicker：FSA 返回 false 后走 <a download> 触发浏览器下载', async () => {
    const adapter = new WebHostAdapter();
    // jsdom 无 createObjectURL/revokeObjectURL，先桩上。
    URL.createObjectURL = vi.fn(() => 'blob:fake-123');
    URL.revokeObjectURL = vi.fn();
    let anchor: HTMLAnchorElement | null = null;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'a') anchor = el as HTMLAnchorElement;
      return el;
    });

    await adapter.showSaveFilePicker('mynote', '{"v":1}');

    expect(saveWithFsa).toHaveBeenCalled();
    expect(anchor!.download).toBe('mynote.kbnote');
    expect(anchor!.href).toContain('blob:');
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
    vi.mocked(document.createElement).mockRestore();
  });

  it('share：navigator.share 不存在时静默返回（不抛错）', async () => {
    const adapter = new WebHostAdapter();
    // jsdom 无 navigator.share
    await expect(adapter.share({ title: 't' })).resolves.toBeUndefined();
  });
});
