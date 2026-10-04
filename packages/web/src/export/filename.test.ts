import { describe, it, expect } from 'vitest';
import {
  buildExportFileName,
  sanitizeFileName,
  formatDateCompact,
  buildPageFileName,
} from './filename';

describe('sanitizeFileName', () => {
  it('替换非法文件名字符', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });
  it('折叠空白并截断首尾点号', () => {
    expect(sanitizeFileName('  我的  笔记  ')).toBe('我的 笔记');
    expect(sanitizeFileName('.hidden.')).toBe('hidden');
  });
  it('超长标题截断到 80 字', () => {
    const long = '字'.repeat(200);
    expect(sanitizeFileName(long).length).toBe(80);
  });
});

describe('buildExportFileName', () => {
  const date = new Date(2026, 9, 5, 14, 30); // 2026-10-05

  it('纵向默认命名', () => {
    expect(
      buildExportFileName({ title: '读书笔记', date, orientation: 'portrait', ext: 'pdf' }),
    ).toBe('读书笔记_20261005_纵向.pdf');
  });

  it('横向命名', () => {
    expect(
      buildExportFileName({ title: '思维导图', date, orientation: 'landscape', ext: 'pdf' }),
    ).toBe('思维导图_20261005_横向.pdf');
  });

  it('中文标题里的非法字符被清洗', () => {
    expect(
      buildExportFileName({ title: '会议/纪要: Q3', date, orientation: 'portrait', ext: 'pdf' }),
    ).toBe('会议_纪要_ Q3_20261005_纵向.pdf');
  });

  it('扩展名大小写归一、点号容错', () => {
    expect(
      buildExportFileName({ title: 't', date, orientation: 'portrait', ext: '.PDF' }),
    ).toBe('t_20261005_纵向.pdf');
  });

  it('日期格式 YYYYMMDD', () => {
    expect(formatDateCompact(new Date(2026, 0, 7))).toBe('20260107');
  });
});

describe('buildPageFileName', () => {
  it('多页 PNG 追加 _p1/_p2', () => {
    expect(buildPageFileName('读书笔记_20261005_纵向.png', 0)).toBe(
      '读书笔记_20261005_纵向_p1.png',
    );
    expect(buildPageFileName('思维导图_20261005_横向.png', 2)).toBe(
      '思维导图_20261005_横向_p3.png',
    );
  });
});
