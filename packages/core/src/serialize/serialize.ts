import type { KBNoteDoc } from '../model/index.js';
import { CURRENT_DOC_VERSION, DOC_FORMAT } from '../model/index.js';
import { safeParseKBNoteDoc } from '../model/index.js';

/**
 * serialize 模块：.kbnote 序列化 / 解析 / 版本迁移。
 * .kbnote 本质是 JSON；这里只做确定性的字符串化与版本升级管线。
 */

export { CURRENT_DOC_VERSION, DOC_FORMAT };

/** 解析 .kbnote 时的类型化错误。kind 区分失败原因。 */
export type KBNoteFileErrorKind = 'invalid-json' | 'wrong-format' | 'unsupported-version' | 'schema';

export class KBNoteFileError extends Error {
  readonly kind: KBNoteFileErrorKind;
  constructor(kind: KBNoteFileErrorKind, message: string) {
    super(message);
    this.name = 'KBNoteFileError';
    this.kind = kind;
  }
}

/**
 * 把文档序列化为 .kbnote 文件内容（UTF-8 JSON，2 空格缩进）。
 * 键序稳定：format/version 在前，其余按模型定义顺序。
 */
export function serializeKBNote(doc: KBNoteDoc): string {
  const ordered: Record<string, unknown> = {
    format: doc.format,
    version: doc.version,
    id: doc.id,
    title: doc.title,
    board: doc.board,
    nodes: doc.nodes,
    edges: doc.edges,
    tags: doc.tags,
    layout: doc.layout,
    viewport: doc.viewport,
    page: doc.page,
    assetRefs: doc.assetRefs,
  };
  return JSON.stringify(ordered, null, 2);
}

/**
 * 迁移管线：一个 version step = 把 v(n) 的 JSON 对象升级为 v(n+1)。
 * 注册 key 为「源版本」。当前只有 v1（恒等，无 step），结构为未来就绪。
 */
export type MigrationStep = (raw: unknown) => unknown;

/** version n -> 升级到 n+1 的 step 注册表。 */
export const MIGRATION_REGISTRY: Record<number, MigrationStep> = {
  // v1 为当前版本，恒等（无需升级）。未来：
  // 1: (raw) => upgradedFromV1ToV2(raw),
};

export interface ParseKBNoteResult {
  doc: KBNoteDoc;
  /** 经过了哪些迁移（从原版本升到 current），无迁移则空数组。 */
  migrationNotes: string[];
}

export interface MigrateResult {
  value: unknown;
  notes: string[];
}

/**
 * 按注册表把 raw（fromVersion 版）逐级升级到 CURRENT_DOC_VERSION。
 * fromVersion === current 时恒等返回。缺少 step 抛 KBNoteFileError。
 */
export function migrate(raw: unknown, fromVersion: number): MigrateResult {
  let current = raw;
  let v = fromVersion;
  const notes: string[] = [];
  while (v < CURRENT_DOC_VERSION) {
    const step = MIGRATION_REGISTRY[v];
    if (!step) {
      throw new KBNoteFileError('unsupported-version', `未注册从版本 ${v} 的迁移步骤`);
    }
    current = step(current);
    v += 1;
    notes.push(`migrated v${v - 1} -> v${v}`);
  }
  return { value: current, notes };
}

/**
 * 解析 .kbnote 文本：JSON.parse → format/version 校验 → 逐级迁移 → zod 校验。
 * 非法 JSON / format 不符 / 版本高于 current / schema 不合法均抛类型化错误。
 */
export function parseKBNote(json: string): ParseKBNoteResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new KBNoteFileError('invalid-json', `文件不是合法 JSON：${(e as Error).message}`);
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new KBNoteFileError('wrong-format', '.kbnote 根节点必须是 JSON 对象');
  }
  const obj = raw as Record<string, unknown>;

  if (obj['format'] !== DOC_FORMAT) {
    throw new KBNoteFileError(
      'wrong-format',
      `format 必须为 "${DOC_FORMAT}"，实际为 ${JSON.stringify(obj['format'])}`,
    );
  }

  const version = obj['version'];
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    throw new KBNoteFileError('wrong-format', 'version 缺失或不是数字');
  }
  if (version > CURRENT_DOC_VERSION) {
    throw new KBNoteFileError(
      'unsupported-version',
      `文件版本 v${version} 高于当前支持的 v${CURRENT_DOC_VERSION}，请升级应用`,
    );
  }

  let migrationNotes: string[] = [];
  let toValidate: unknown = raw;
  if (version < CURRENT_DOC_VERSION) {
    const result = migrate(raw, version);
    toValidate = result.value;
    migrationNotes = result.notes;
  }

  const parsed = safeParseKBNoteDoc(toValidate);
  if (!parsed.success) {
    throw parsed.error;
  }
  return { doc: parsed.doc, migrationNotes };
}
