import type { HostAdapter, OpenFileResult } from '@drawpaper/core';
import { openWithFsa, saveWithFsa } from '../storage/fsa';

/**
 * Web HostAdapter：文件选择/保存/打印/分享。
 * 优先 File System Access API；不支持时降级 <input type=file> / <a download>。
 */

function openViaInput(): Promise<OpenFileResult | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.kbnote,application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file.text().then(
        (text) => resolve({ name: file.name, text }),
        () => resolve(null),
      );
    };
    // 用户取消选择：无事件，按超时兜底（不阻塞主流程）。
    input.click();
  });
}

function downloadViaAnchor(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  downloadBlobViaAnchor(blob, filename.endsWith('.kbnote') ? filename : `${filename}.kbnote`);
}

/** Blob → a[download] 触发浏览器下载（share 兜底 / 任意 blob 通用）。 */
function downloadBlobViaAnchor(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 宿主是否有 Web Share API（移动端 Safari 才有；桌面 Safari/WebKit/Chrome 常无）。 */
export function webCanShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/** 用户取消分享（AbortError）不属于错误，静默。 */
function isShareAbort(err: unknown): boolean {
  return (err as { name?: string } | null | undefined)?.name === 'AbortError';
}

export class WebHostAdapter implements HostAdapter {
  async showOpenFilePicker(): Promise<OpenFileResult | null> {
    const fsa = await openWithFsa();
    if (fsa) return fsa;
    return openViaInput();
  }

  async showSaveFilePicker(filename: string, text: string): Promise<void> {
    const ok = await saveWithFsa(filename, text);
    if (!ok) downloadViaAnchor(filename, text);
  }

  print(): void {
    window.print();
  }

  /**
   * 分享：优先 Web Share API（移动端 Safari）。
   * 不支持（桌面 Safari/WebKit/旧浏览器）或分享以非取消原因失败时，
   * 降级为浏览器下载（.kbnote 文本 / blob 文件），绝不静默无反应。
   */
  async share(payload: { title: string; text?: string; file?: Blob }): Promise<void> {
    if (webCanShare()) {
      try {
        await navigator.share(payload as ShareData);
        return;
      } catch (e) {
        if (isShareAbort(e)) return; // 用户主动取消，不兜底下载。
        // 其他失败（如不支持的 file 类型 / 被拦）→ 落到下面的下载兜底。
      }
    }
    // Web Share 不可用 / 失败：下载兜底。
    const base = (payload.title || 'drawpaper').replace(/[\\/:*?"<>|\s]+/g, '-');
    if (payload.file) {
      downloadBlobViaAnchor(payload.file, `${base}.kbpack`);
    } else if (typeof payload.text === 'string') {
      downloadViaAnchor(`${base}.kbnote`, payload.text);
    }
  }
}
