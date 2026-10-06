import { getTauriExportHost, type ExportExt } from '@/host/tauri-host';
import { pushToast } from '@/panels/lib/toast';

/**
 * Wave13：导出产物交付 sink。
 *
 * 同一份 `(fileName, blob)` 在两种宿主下落不同地：
 *  - 浏览器 / PWA：维持既有 `<a download>` Blob 下载链路不变（多页 PNG/SVG 逐页触发）。
 *  - 桌面 Tauri：改调冻结的 `save_export`（Rust 原生 Save 对话框 + 写盘），
 *    `suggestedName` 与浏览器下载文件名逐字一致（调用方复用同一 fileName）。
 *
 * 取消语义（A 路契约）：Rust 把「用户取消 Save 对话框」作为 resolve
 * `{status:'cancelled'}` 返回——这里静默忽略，绝不弹错误 toast。
 * 写盘失败 / base64 解码失败 → reject(string) → toast 写盘失败。
 */
function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * 交付一个导出文件。桌面端 cancelled 静默；写盘失败 toast。
 * 浏览器端永远走 Blob 下载。
 */
export async function deliverExportFile(
  fileName: string,
  ext: ExportExt,
  blob: Blob,
): Promise<void> {
  const host = getTauriExportHost();
  if (!host) {
    triggerBrowserDownload(blob, fileName);
    return;
  }
  try {
    const outcome = await host.saveExport({ suggestedName: fileName, ext, bytes: blob });
    if (outcome.status === 'cancelled') return; // 正常取消，静默
    // status === 'saved'：Rust 已写盘，路径在 outcome.path；不弹 toast（避免打扰）。
  } catch (err) {
    pushToast('error', `导出保存失败：${typeof err === 'string' ? err : '写盘出错'}`);
  }
}
