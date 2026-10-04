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
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.kbnote') ? filename : `${filename}.kbnote`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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

  async share(payload: { title: string; text?: string; file?: Blob }): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.share) return;
    try {
      await navigator.share(payload as ShareData);
    } catch {
      /* 用户取消或不支持 */
    }
  }
}
