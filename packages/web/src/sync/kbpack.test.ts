import { describe, it, expect } from 'vitest';
import { crc32, packZip, unpackZip, encodeText, decodeText, KbpackError, SIG_EOCD } from './kbpack';
import {
  buildKbpackManifest,
  parseKbpackManifest,
  planKbpackImport,
} from './kbpack-manifest';
import { resolveCopyAsWinner } from './conflict-copies';
import type { KBNoteDoc } from '@drawpaper/core';

/**
 * kbpack 纯函数单测：CRC32 已知向量 / store-only ZIP 打包解包往返（中文文件名、多文件、空包）/
 * manifest 合并决策 / 冲突「副本胜」纯函数。
 * ZIP 结构另在 e2e 用系统 unzip 交叉验证（EOCD 签名 0x06054b50）。
 */

const ascii = (s: string): Uint8Array => encodeText(s);

describe('crc32', () => {
  it('标准已知向量：CRC32("123456789") = 0xCBF43926', () => {
    expect(crc32(ascii('123456789'))).toBe(0xcbf43926);
  });
  it('空串 = 0', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
  it('单字节 "a" = 0xE8B7BE43（zlib 向量）', () => {
    expect(crc32(ascii('a'))).toBe(0xe8b7be43);
  });
  it('确定性：同输入多次结果一致；输入变一位 CRC 必变', () => {
    const a = ascii('The quick brown fox');
    expect(crc32(a)).toBe(crc32(a));
    const b = a.slice();
    b[0]! ^= 0x01;
    expect(crc32(b)).not.toBe(crc32(a));
  });
});

describe('packZip / unpackZip 往返', () => {
  it('空包：仅 EOCD，可解出 0 项', () => {
    const bytes = packZip([]);
    // 末尾 22 字节必须是 EOCD 签名。
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    expect(view.getUint32(bytes.length - 22, true)).toBe(SIG_EOCD);
    expect(unpackZip(bytes)).toEqual([]);
  });

  it('多文件：往返一致（含中文文件名、二进制与文本）', () => {
    const hello = ascii('你好，世界');
    const bin = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    const entries = [
      { name: 'manifest.json', data: ascii('{"ok":true}') },
      { name: 'docs/笔记-甲.kbnote', data: hello },
      { name: 'assets/abc123', data: bin },
    ];
    const packed = packZip(entries);
    const out = unpackZip(packed);
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.name)).toEqual([
      'manifest.json',
      'docs/笔记-甲.kbnote',
      'assets/abc123',
    ]);
    expect(decodeText(out[0]!.data)).toBe('{"ok":true}');
    expect(decodeText(out[1]!.data)).toBe('你好，世界');
    expect(Array.from(out[2]!.data)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
  });

  it('解包损坏字节 → bad-crc', () => {
    const data = ascii('hello world, this is a payload to corrupt');
    const packed = packZip([{ name: 'a.txt', data }]);
    // 数据区偏移 = 本地头 30 + 文件名 "a.txt" 5 = 35；翻数据区内一个字节。
    packed[40]! ^= 0xff;
    let caught: unknown;
    try {
      unpackZip(packed);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KbpackError);
    expect((caught as KbpackError).kind).toBe('bad-crc');
  });

  it('非 ZIP 字节 → not-zip', () => {
    let caught: unknown;
    try {
      unpackZip(ascii('just plain text, not a zip'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KbpackError);
    expect((caught as KbpackError).kind).toBe('not-zip');
  });

  it('中央目录记录条目数与实际文件数一致', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      name: `f${i}.txt`,
      data: ascii(`content-${i}`),
    }));
    const packed = packZip(entries);
    const view = new DataView(packed.buffer, packed.byteOffset, packed.length);
    // EOCD 处 total entries (offset+10) = 5。
    const eocd = packed.length - 22;
    expect(view.getUint16(eocd + 10, true)).toBe(5);
    expect(unpackZip(packed)).toHaveLength(5);
  });
});

// ---- 造一份最小 v3 文档 ----
function makeDoc(id: string, title: string, text: string, vv: Record<string, number>): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: 3,
    id,
    title,
    board: { createdAt: 1000, updatedAt: 2000 },
    nodes: [
      {
        id: `${id}-n1`,
        type: 'text',
        x: 0,
        y: 0,
        width: 200,
        height: 80,
        content: { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text }] } },
        parentId: null,
        tags: [],
      },
    ],
    edges: [],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: true, colorMode: 'color', header: false, footer: false, showPageNumbers: false, edgeLabels: true, pageBreaks: [] },
    assetRefs: [],
    links: [],
    sync: { vv, nodes: { [`${id}-n1`]: { f: { content: [vv['c'] ?? 1, 'c'] } } } },
  } as unknown as KBNoteDoc;
}

describe('kbpack manifest 合并决策', () => {
  it('buildKbpackManifest + planKbpackImport：本端没有→new，已有→merge，资产取并集差', () => {
    const docs = [
      makeDoc('doc-a', '甲', 'A', { c: 1 }),
      makeDoc('doc-b', '乙', 'B', { c: 2 }),
    ];
    docs[1]!.assetRefs = ['asset-x'];
    const manifest = buildKbpackManifest(docs, 'device-1');
    expect(manifest.docs['doc-a']!.file).toBe('docs/doc-a.kbnote');
    expect(manifest.docs['doc-a']!.vv).toEqual({ c: 1 });
    expect(manifest.docs['doc-b']!.assets).toEqual(['asset-x']);

    // 本端已有 doc-a，没有 doc-b；本端已有 asset-y。
    const plan = planKbpackImport(new Set(['doc-a']), new Set(['asset-y']), manifest);
    expect(plan.decisions['doc-a']).toBe('merge');
    expect(plan.decisions['doc-b']).toBe('new');
    // 包内 asset-x 本端缺 → 待回填；asset-y 已有 → 不重复。
    expect(plan.missingAssets).toEqual(['asset-x']);
    expect(plan.totalDocs).toBe(2);
  });

  it('manifest.json 往返解析：合法通过，错格式抛错', () => {
    const m = buildKbpackManifest([makeDoc('d1', 't', 'x', { c: 1 })], 'dev');
    const back = parseKbpackManifest(JSON.stringify(m));
    expect(back.docs['d1']!.title).toBe('t');
    expect(() => parseKbpackManifest('{"format":"wrong"}')).toThrowError('kbpack-manifest');
  });
});

describe('冲突副本「副本胜」纯函数', () => {
  it('副本正文/标题胜出，vv 取并集，资产取并集，墓碑传播', () => {
    const local = makeDoc('doc-1', '本端标题', '本端内容', { devA: 5 });
    const copy = makeDoc('doc-1', '副本标题', '副本内容', { devB: 9 });
    // 本地删掉了一个本地节点（墓碑），副本没有；合并后应保留墓碑。
    (local.sync.nodes as Record<string, unknown>)['local-gone'] = { t: [7, 'devA'] };
    local.assetRefs = ['asset-local'];
    copy.assetRefs = ['asset-copy'];

    const merged = resolveCopyAsWinner(local, copy);
    expect(merged.title).toBe('副本标题');
    expect(merged.nodes[0]!.content).toEqual(copy.nodes[0]!.content);
    // vv 并集。
    expect(merged.sync.vv).toEqual({ devA: 5, devB: 9 });
    // 资产并集。
    expect([...merged.assetRefs].sort()).toEqual(['asset-copy', 'asset-local']);
    // 本地墓碑传播（不复活）。
    expect((merged.sync.nodes as Record<string, unknown>)['local-gone']).toEqual({ t: [7, 'devA'] });
  });
});
