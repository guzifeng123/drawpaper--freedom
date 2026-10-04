/**
 * 导出文件名工具（纯函数，单测覆盖）。
 * 默认形态：{标题}_{YYYYMMDD}_{纵向|横向}.pdf
 * 例：`读书笔记_20261005_纵向.pdf`
 */
import type { PageOrientation } from '@drawpaper/core';

/** 清洗文件名字符：非法字符替换为下划线，折叠空白，截断长度。 */
export function sanitizeFileName(title: string): string {
  return title
    // 非法文件名字符 / 控制字符（0x00-0x1f 必须剔除，no-control-regex 此处为有意为之）
    // eslint-disable-next-line no-control-regex -- 文件名清洗需剔除 C0 控制字符
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    // 折叠连续空白
    .replace(/\s+/g, ' ')
    .trim()
    // 去掉首尾点号（Windows 不允许）
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80);
}

/** Date → YYYYMMDD（本地时区）。 */
export function formatDateCompact(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

const ORIENTATION_LABEL: Record<PageOrientation, string> = {
  portrait: '纵向',
  landscape: '横向',
};

export interface ExportFileNameInput {
  title: string;
  date: Date;
  orientation: PageOrientation;
  /** 扩展名（不含点），如 'pdf' | 'png'。 */
  ext: string;
}

/** 构造默认导出文件名。 */
export function buildExportFileName({ title, date, orientation, ext }: ExportFileNameInput): string {
  const base = `${sanitizeFileName(title)}_${formatDateCompact(date)}_${ORIENTATION_LABEL[orientation]}`;
  const e = ext.replace(/^\.+/, '').toLowerCase() || 'pdf';
  return `${base}.${e}`;
}

/** 多页位图导出：在主文件名基础上加 _p1/_p2…（扩展名替换）。 */
export function buildPageFileName(baseFileName: string, pageIndex: number): string {
  const dot = baseFileName.lastIndexOf('.');
  if (dot < 0) return `${baseFileName}_p${pageIndex + 1}`;
  return `${baseFileName.slice(0, dot)}_p${pageIndex + 1}${baseFileName.slice(dot)}`;
}
