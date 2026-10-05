import type { KBNoteDoc } from '@drawpaper/core';

/**
 * 总览数据提供者接口（只读）。
 * Wave7 挂载点：web 用 DexieOverviewProvider 接入真实库；e2e/组件测试用 mock。
 */
export interface OverviewProvider {
  /** 读取全部文档（只读，不修改任何表），聚合为 overview 输入。 */
  loadAllDocs(): Promise<KBNoteDoc[]>;
}

/** 文档分组调色板（总览专用，区别于边色常量体系；UI 注明「文档分组色」）。 */
export const DOC_GROUP_PALETTE: readonly string[] = [
  '#93C5FD', // 蓝
  '#86EFAC', // 绿
  '#FCD34D', // 黄
  '#D8B4FE', // 紫
  '#F9A8D4', // 粉
  '#67E8F9', // 青
  '#FDBA74', // 橙
  '#A3E635', //  Lime
] as const;

/** 按 docId 稳定取色（字典序 → 调色板循环）。 */
export function docColor(docId: string, allDocIds: string[]): string {
  const sorted = [...allDocIds].sort();
  const idx = sorted.indexOf(docId);
  if (idx < 0) return DOC_GROUP_PALETTE[0]!;
  return DOC_GROUP_PALETTE[idx % DOC_GROUP_PALETTE.length]!;
}
