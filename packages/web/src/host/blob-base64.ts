/**
 * Wave13：Blob → base64 纯函数（供桌面端 save_export 把导出字节传给 Rust）。
 *
 * 抽出为独立纯函数便于单测：输入任意 Blob，输出标准 base64（无换行）。
 * 用 FileReader.readAsArrayBuffer（jsdom / WebView2 都支持）；大 PNG
 * （pixelRatio≈3）可能数 MB，btoa 一次吃整段 binary string 有调用栈风险，
 * 这里按 32KB 分块拼接再一次性 btoa。
 */

function readAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader 读取 Blob 失败'));
    reader.readAsArrayBuffer(blob);
  });
}

/** 把 Blob 转成标准 base64（无换行、标准字母表）。 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await readAsArrayBuffer(blob);
  const bytes = new Uint8Array(buf);
  // 分块：String.fromCharCode 单次参数过多会栈溢出，按 0x8000 (32KB) 切片。
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
