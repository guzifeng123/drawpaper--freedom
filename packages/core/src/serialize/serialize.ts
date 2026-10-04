import type { KBNoteDoc } from '../model/index.js';
import { CURRENT_DOC_VERSION, DOC_FORMAT } from '../model/index.js';
import { parseKBNoteDoc } from '../model/index.js';

/**
 * serialize 模块：.kbnote 序列化 / 解析 / 版本迁移。
 * .kbnote 本质是 JSON；这里只做确定性的字符串化与版本升级管线骨架。
 */

export { CURRENT_DOC_VERSION, DOC_FORMAT };

/**
 * 把文档序列化为 .kbnote 文件内容（UTF-8 JSON，2 空格缩进）。
 */
export function serializeKBNote(doc: KBNoteDoc): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * 迁移管线：一个版本 step = 把 v(n) 的 JSON 对象升级为 v(n+1)。
 * 注册 key 为「源版本」。parse 时从文档当前 version 逐级升级到 currentVersion。
 */
export type MigrationStep = (doc: Record<string, unknown>) => Record<string, unknown>;

/** version n -> 升级到 n+1 的 step 注册表。 */
export const MIGRATION_REGISTRY: Record<number, MigrationStep> = {
  // 当前仅 version=1，暂无 step。未来：
  // 1: (doc) => upgradedFromV1ToV2(doc),
};

export interface ParseKBNoteResult {
  doc: KBNoteDoc;
  /** 经过了哪些迁移（从原版本升到 current），无迁移则空数组。 */
  migrationNotes: string[];
}

/**
 * 解析 .kbnote 文本：先 JSON.parse，再按 version 逐级迁移，最后用 zod 校验为 KBNoteDoc。
 * 失败抛错（由 UI 提示）。
 * 【TODO wave1-a】迁移升级循环当前为骨架：version!==1 时暂抛错。
 */
export function parseKBNote(json: string): ParseKBNoteResult {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const migrationNotes: string[] = [];

  let current = raw;
  let v = typeof current['version'] === 'number' ? (current['version'] as number) : 1;

  while (v < CURRENT_DOC_VERSION) {
    const step = MIGRATION_REGISTRY[v];
    if (!step) {
      throw new Error(`No migration step registered from version ${v}`);
    }
    current = step(current);
    v += 1;
    migrationNotes.push(`migrated v${v - 1} -> v${v}`);
  }

  const doc = parseKBNoteDoc(current);
  return { doc, migrationNotes };
}
