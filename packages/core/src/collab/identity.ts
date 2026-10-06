import { nanoid } from 'nanoid';

/**
 * 标签页身份（同浏览器多标签协作）。
 *
 * 每个打开文档的标签页有一个稳定的 clientId：同标签页刷新前不变，
 * 刷新后由 B 端从 sessionStorage 恢复；core 不碰 sessionStorage（宿主 API 属 web）。
 * 本模块只提供「生成纯函数 + 可编辑展示名 + 标签颜色」的纯类型与工具。
 */

/** 协作客户端 id（业务前缀 c_ + nanoid）。仅作字符串用，不做 brand，避免 B 端样板。 */
export type ClientId = string;

/** 标签颜色（展示用）： presence 光标 / 冲突横幅 / 远端选区高亮描边。 */
export interface TabIdentity {
  clientId: ClientId;
  /** 用户可编辑的标签页显示名（如「主窗口」「iPad 侧屏」）。 */
  name: string;
  /** 十六进制颜色（#rrggbb），来自 {@link TAB_COLOR_PALETTE}。 */
  color: string;
}

/** 标签页颜色板（8 色，兼顾亮/暗主题）。 */
export const TAB_COLOR_PALETTE: readonly string[] = [
  '#3b82f6', // 蓝
  '#ef4444', // 红
  '#10b981', // 绿
  '#f59e0b', // 琥珀
  '#8b5cf6', // 紫
  '#ec4899', // 粉
  '#06b6d4', // 青
  '#f97316', // 橙
] as const;

/** 默认标签页名（用户可改）。 */
export const DEFAULT_TAB_NAME = '未命名标签页';

/** 生成一个全新的随机 clientId（纯函数；底层 nanoid 在 node/浏览器均可用，core 不引入宿主 API）。 */
export function generateClientId(): ClientId {
  return `c_${nanoid(10)}`;
}

/**
 * 按确定性种子挑选标签颜色：seed 对调色板取模。
 * 同浏览器多标签时，B 端可用「已存在的 clientId 数量」作 seed，尽量错开颜色。
 */
export function pickTabColor(seed: number): string {
  const i = Math.abs(Math.floor(seed)) % TAB_COLOR_PALETTE.length;
  return TAB_COLOR_PALETTE[i] as string;
}

/**
 * 构造一个标签身份。name 缺省用 {@link DEFAULT_TAB_NAME}；
 * color 缺省由 seed 确定性挑选（seed 缺省 0 → 蓝）。
 */
export function createTabIdentity(name?: string, opts: { seed?: number; color?: string } = {}): TabIdentity {
  return {
    clientId: generateClientId(),
    name: name && name.trim().length > 0 ? name.trim() : DEFAULT_TAB_NAME,
    color: opts.color ?? pickTabColor(opts.seed ?? 0),
  };
}
