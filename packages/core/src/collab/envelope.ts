import { z } from 'zod';
import type { ZodError } from 'zod';
import { CollabOpSchema, PresenceSchema, SnapshotDataSchema } from './ops.js';
import type { ClientId } from './identity.js';

/**
 * 信封（Envelope）：同浏览器多标签之间广播的最小消息单元。
 *
 * 所有信封共享一个头部：
 * - v：协议版本（当前 1）。阶段 B 收到 v 不符直接丢弃并告警。
 * - docId / clientId / tabName / tabColor：路由与展示。
 * - lamport：发送方发出本信封时的逻辑时钟值（LWW 与版本向量的时间来源）。
 *
 * 消息类型（kind 判别联合）：
 * - op               一条文档变更（CollabOp）。
 * - presence         现场状态（选区/高亮/心跳），不进合并引擎、不写 doc。
 * - snapshot-request late-joiner 请求对齐（携带自己的版本向量）。
 * - snapshot         持有方回基线文档 + 基线版本向量 + 增量 op。
 */

/** 协议版本。破坏性变更 +1。 */
export const COLLAB_PROTOCOL_VERSION = 1 as const;

const HeaderSchema = z.object({
  v: z.literal(COLLAB_PROTOCOL_VERSION),
  docId: z.string().min(1),
  clientId: z.string().min(1),
  tabName: z.string().default('未命名标签页'),
  tabColor: z.string().default('#3b82f6'),
  lamport: z.number().int().nonnegative(),
});
export type EnvelopeHeader = z.infer<typeof HeaderSchema>;

const OpEnvelopeSchema = HeaderSchema.extend({
  kind: z.literal('op'),
  /** 全局唯一 op id（nanoid）：乱序/重复/延迟到达都靠它幂等去重。 */
  opId: z.string().min(1),
  op: CollabOpSchema,
});

const PresenceEnvelopeSchema = HeaderSchema.extend({
  kind: z.literal('presence'),
  presence: PresenceSchema,
});

const SnapshotRequestSchema = HeaderSchema.extend({
  kind: z.literal('snapshot-request'),
  /** 请求方当前的版本向量（空 = 全新加入，要全量基线）。 */
  requestVv: z.record(z.number()),
});

const SnapshotEnvelopeSchema = HeaderSchema.extend({
  kind: z.literal('snapshot'),
  snapshot: SnapshotDataSchema,
});

export const CollabEnvelopeSchema = z.discriminatedUnion('kind', [
  OpEnvelopeSchema,
  PresenceEnvelopeSchema,
  SnapshotRequestSchema,
  SnapshotEnvelopeSchema,
]);

export type CollabEnvelope = z.infer<typeof CollabEnvelopeSchema>;
export type OpEnvelope = Extract<CollabEnvelope, { kind: 'op' }>;
export type PresenceEnvelope = Extract<CollabEnvelope, { kind: 'presence' }>;
export type SnapshotRequestEnvelope = Extract<CollabEnvelope, { kind: 'snapshot-request' }>;
export type SnapshotEnvelope = Extract<CollabEnvelope, { kind: 'snapshot' }>;

/** 信封解析失败的可识别错误（B 端 catch 后丢弃该消息，绝不污染本地状态）。 */
export type CollabProtocolErrorCode =
  | 'bad-json'
  | 'bad-envelope'
  | 'version-mismatch'
  | 'bad-doc'
  | 'unknown-kind';

export class CollabProtocolError extends Error {
  readonly code: CollabProtocolErrorCode;
  readonly issues: readonly string[];

  constructor(code: CollabProtocolErrorCode, message: string, issues: ReadonlyArray<string> = []) {
    super(message);
    this.name = 'CollabProtocolError';
    this.code = code;
    this.issues = issues;
  }
}

function zodIssues(err: ZodError): string[] {
  return err.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
}

/**
 * 序列化信封为字符串（BroadcastChannel.postMessage 直接发；结构化克隆对象亦可直接发，
 * 本函数只负责 JSON 一把梭，保证 B 端两端实现一致）。
 */
export function serializeEnvelope(env: CollabEnvelope): string {
  return JSON.stringify(env);
}

/**
 * 解析并校验一条收到的信封（来自 unknown JSON / structuredClone 对象）。
 * - 非法 JSON / 形状不对 / 协议版本不符 / 文档基线损坏 → 抛 {@link CollabProtocolError}，
 *   调用方必须丢弃该消息，不应用任何状态。
 */
export function parseEnvelope(raw: unknown): CollabEnvelope {
  let input: unknown = raw;
  if (typeof raw === 'string') {
    try {
      input = JSON.parse(raw);
    } catch (e) {
      throw new CollabProtocolError('bad-json', `协作信封不是合法 JSON：${(e as Error).message}`);
    }
  }
  // 协议版本预检（给出比 zod 更可读的错误码）。
  if (typeof input === 'object' && input !== null && 'v' in input) {
    const v = (input as { v: unknown }).v;
    if (typeof v !== 'number' || v !== COLLAB_PROTOCOL_VERSION) {
      throw new CollabProtocolError(
        'version-mismatch',
        `协作协议版本不兼容：收到 v=${String(v)}，本端 v=${COLLAB_PROTOCOL_VERSION}`,
      );
    }
  }
  const parsed = CollabEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    const issues = zodIssues(parsed.error);
    throw new CollabProtocolError(
      'bad-envelope',
      `协作信封校验失败（${issues.length} 处）`,
      issues,
    );
  }
  return parsed.data;
}

/** 类型守卫：是不是 op 信封。 */
export function isOpEnvelope(env: CollabEnvelope): env is OpEnvelope {
  return env.kind === 'op';
}

export type { ClientId };
