/**
 * .kbpack 备份包（Wave11 阶段 B）——手写 store-only ZIP，零依赖。
 *
 * 约束（红线）：
 *  - 严禁引入 jszip/fflate/yauzl 等任何 zip/压缩库；本文件纯手写。
 *  - store-only（method=0，不压缩）：图片/附件本身已压缩，再 deflate 只费 CPU 不省体积。
 *  - 纯函数：只吃/吐 Uint8Array，零 DOM、零网络、零定时器。
 *
 * 二进制结构（标准 ZIP，可用系统 `unzip` 交叉验证）：
 *   [本地文件头 30B][文件名][文件数据]            × N（顺序写，记录每段 offset）
 *   [中央目录头 46B][文件名]                      × N
 *   [EOCD 22B，签名 0x06054b50]
 *
 * 文件名统一 UTF-8（GP 位标志 bit 11 = 0x0800），含中文文件名也能被系统 unzip 正确解码。
 * CRC32：标准 IEEE 802.3 反射多项式 0xEDB88320，init/final XOR 0xFFFFFFFF
 *        （已知向量 CRC32("123456789") = 0xCBF43926，见单测）。
 */

// ---------------- CRC32 ----------------

/** 惰性构建 CRC32 查找表（256 项）。 */
let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

/**
 * 标准 CRC32（IEEE）。输入任意字节串；返回无符号 32 位。
 * 已知向量：crc32(ascii("123456789")) === 0xcb_f4_39_26。
 */
export function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = table[(crc ^ (data[i] ?? 0)) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------- 字节写入小工具 ----------------

/** 小端写 uint16。 */
function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}
/** 小端写 uint32。 */
function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function concatBuffers(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------- 打包 ----------------

export interface PackEntry {
  /** 条目相对路径（POSIX，UTF-8），如 `manifest.json` / `docs/<docId>.kbnote` / `assets/<ref>`。 */
  name: string;
  data: Uint8Array;
}

/** GP 位标志：bit 11 (0x0800) = 文件名/注释为 UTF-8。 */
const GP_UTF8 = 0x0800;
/** 本地文件头签名。 */
const SIG_LOCAL = 0x04034b50;
/** 中央目录头签名。 */
const SIG_CENTRAL = 0x02014b50;
/** EOCD 签名。 */
export const SIG_EOCD = 0x06054b50;
/** 压缩方式：store（不压缩）。 */
const METHOD_STORE = 0;
/** 固定的 DOS 时间/日期（午夜 1980-01-01）——备份包内容以 manifest.json 记录真实 mtime。 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01

/**
 * 把若干条目打包成 store-only ZIP 字节流。
 * 条目顺序即写入顺序（稳定、可预测，便于单测断言）。空数组也产出合法空包（仅 EOCD）。
 */
export function packZip(entries: PackEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    // ---- 本地文件头 ----
    const localHeader = new Uint8Array(30);
    const lh = new DataView(localHeader.buffer);
    writeU32(lh, 0, SIG_LOCAL);
    writeU16(lh, 4, 20); // version needed 2.0
    writeU16(lh, 6, GP_UTF8);
    writeU16(lh, 8, METHOD_STORE);
    writeU16(lh, 10, DOS_TIME);
    writeU16(lh, 12, DOS_DATE);
    writeU32(lh, 14, crc);
    writeU32(lh, 18, size); // compressed == uncompressed (store)
    writeU32(lh, 22, size);
    writeU16(lh, 26, nameBytes.length);
    writeU16(lh, 28, 0); // extra len
    localParts.push(localHeader, nameBytes, entry.data);

    // ---- 中央目录头 ----
    const centralHeader = new Uint8Array(46);
    const ch = new DataView(centralHeader.buffer);
    writeU32(ch, 0, SIG_CENTRAL);
    writeU16(ch, 4, 20); // version made by
    writeU16(ch, 6, 20); // version needed
    writeU16(ch, 8, GP_UTF8);
    writeU16(ch, 10, METHOD_STORE);
    writeU16(ch, 12, DOS_TIME);
    writeU16(ch, 14, DOS_DATE);
    writeU32(ch, 16, crc);
    writeU32(ch, 20, size);
    writeU32(ch, 24, size);
    writeU16(ch, 28, nameBytes.length);
    writeU16(ch, 30, 0); // extra len
    writeU16(ch, 32, 0); // comment len
    writeU16(ch, 34, 0); // disk number start
    writeU16(ch, 36, 0); // internal attrs
    writeU32(ch, 38, 0); // external attrs
    writeU32(ch, 42, offset); // relative offset of local header
    centralParts.push(centralHeader, nameBytes);

    offset += 30 + nameBytes.length + entry.data.length;
  }

  const centralDir = concatBuffers(centralParts);
  const localData = concatBuffers(localParts);

  // ---- EOCD ----
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  writeU32(ev, 0, SIG_EOCD);
  writeU16(ev, 4, 0); // disk number
  writeU16(ev, 6, 0); // central dir disk
  writeU16(ev, 8, entries.length); // entries this disk
  writeU16(ev, 10, entries.length); // total entries
  writeU32(ev, 12, centralDir.length); // CD size
  writeU32(ev, 16, localData.length); // CD offset
  writeU16(ev, 20, 0); // comment len

  return concatBuffers([localData, centralDir, eocd]);
}

// ---------------- 解包 ----------------

/** 解包结果。 */
export interface UnpackedEntry {
  name: string;
  data: Uint8Array;
}

export class KbpackError extends Error {
  readonly kind: 'not-zip' | 'bad-crc' | 'unsupported-method' | 'truncated';
  constructor(kind: KbpackError['kind'], message: string) {
    super(message);
    this.name = 'KbpackError';
    this.kind = kind;
  }
}

/**
 * 解析 store-only ZIP（只读我们自己写出的、method=0、无加密、无数据描述符的包）。
 * 以中央目录为准遍历（更鲁棒），逐条校验 CRC32。
 * 非本格式 / CRC 不符 / 用了压缩方法 → 抛 KbpackError。
 */
export function unpackZip(bytes: Uint8Array): UnpackedEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.length;

  // 1) 找 EOCD（从尾部最多 64KB 内搜签名；本包无注释）。
  let eocdOff = -1;
  const minSearch = Math.max(0, len - 22 - 65536);
  for (let i = len - 22; i >= minSearch; i -= 1) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff < 0) throw new KbpackError('not-zip', '找不到 EOCD 签名（不是合法 .kbpack/ZIP）');

  const totalEntries = view.getUint16(eocdOff + 10, true);
  const cdSize = view.getUint32(eocdOff + 12, true);
  const cdOffset = view.getUint32(eocdOff + 16, true);
  void cdSize;

  // 2) 遍历中央目录。
  const out: UnpackedEntry[] = [];
  let p = cdOffset;
  const decoder = new TextDecoder();
  for (let i = 0; i < totalEntries; i += 1) {
    if (view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new KbpackError('not-zip', `中央目录第 ${i} 项签名不符（offset ${p}）`);
    }
    const method = view.getUint16(p + 10, true);
    if (method !== METHOD_STORE) {
      throw new KbpackError('unsupported-method', `条目 ${i} 使用压缩方式 ${method}，本包只支持 store-only`);
    }
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);

    const nameStart = p + 46;
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLen);
    const name = decoder.decode(nameBytes);

    // 中央目录头前进到下一项。
    p += 46 + nameLen + extraLen + commentLen;

    // 3) 跳到本地头，读数据区。
    if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw new KbpackError('not-zip', `本地头签名不符（offset ${localOffset}，条目 ${name}）`);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = bytes.subarray(dataStart, dataStart + compSize);
    if (data.length !== compSize) {
      throw new KbpackError('truncated', `条目 ${name} 数据被截断（期望 ${compSize}，实得 ${data.length}）`);
    }

    // 4) CRC32 校验。
    if (crc32(data) !== crc) {
      throw new KbpackError('bad-crc', `条目 ${name} CRC32 校验失败（包损坏）`);
    }
    out.push({ name, data: new Uint8Array(data) });
  }
  return out;
}

// ---------------- 便捷编码/解码 ----------------

/** 文本 → UTF-8 字节。 */
export function encodeText(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
/** UTF-8 字节 → 文本。 */
export function decodeText(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
