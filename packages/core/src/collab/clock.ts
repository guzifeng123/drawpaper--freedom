import type { ClientId } from './identity.js';

/**
 * Lamport 逻辑时钟 + 版本向量（纯函数/纯类，零宿主 API）。
 *
 * 规则（标准 Lamport）：
 * - 本地发送前 tick()：clock = clock + 1。
 * - 收到远端消息 observe(remoteTs)：clock = max(clock, remoteTs) + 1。
 *   → 永远不会回拨：远端旧时间戳只让本地自增 1；远端领先则向前跳到其值+1。
 *
 * 同 Lamport 同帧并发的决序： Lamport 相等时按 clientId 字典序，**小者胜**（确定性全序）。
 */

/** 一个带作者的逻辑事件定位（LWW 比较的最小单位）。 */
export interface EventMarker {
  lamport: number;
  clientId: ClientId;
}

/** 版本向量：clientId → 该客户端已观察到的最高 Lamport 值。 */
export type VersionVector = Record<ClientId, number>;

/**
 * 比较两个事件在「确定性全序」中的先后。
 * 主关键字 Lamport 升序；次关键字 clientId：字典序**小者排后（视为更晚/胜者）**。
 * 返回 -1 表示 a 早于 b，1 表示 a 晚于 b，0 表示完全相等（同 clientId 同 lamport，理论上不会出现两次）。
 */
export function compareEvents(a: EventMarker, b: EventMarker): -1 | 0 | 1 {
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1;
  if (a.clientId === b.clientId) return 0;
  // 同 Lamport：clientId 小者排后（胜方），因此 a.clientId 小 → a 排后 → 返回 1。
  return a.clientId < b.clientId ? 1 : -1;
}

/**
 * 字段级 LWW 判定：candidate 是否应当盖过 incumbent。
 * - Lamport 较大者胜；
 * - 同 Lamport（同帧并发）：clientId 字典序小者胜。
 */
export function lwwBeats(candidate: EventMarker, incumbent: EventMarker): boolean {
  return compareEvents(candidate, incumbent) > 0;
}

/** 版本向量偏序关系。 */
export type VvRelation = 'equal' | 'before' | 'after' | 'concurrent';

/**
 * 比较两个版本向量的因果关系。
 * - before：a ≤ b 且 a ≠ b（b 已包含 a 的全部事件）
 * - after：a ≥ b 且 a ≠ b
 * - concurrent：互相都不包含
 * - equal：完全相等
 */
export function compareVersions(a: VersionVector, b: VersionVector): VvRelation {
  const keys = new Set<ClientId>([...Object.keys(a), ...Object.keys(b)]);
  let lt = false;
  let gt = false;
  for (const k of keys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (av < bv) lt = true;
    else if (av > bv) gt = true;
  }
  if (lt && gt) return 'concurrent';
  if (lt) return 'before';
  if (gt) return 'after';
  return 'equal';
}

/** 合并两个版本向量（逐分量取 max）。 */
export function mergeVersions(a: VersionVector, b: VersionVector): VersionVector {
  const out: VersionVector = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = Math.max(out[k] ?? 0, v);
  }
  return out;
}

/** 空版本向量。 */
export function emptyVersionVector(): VersionVector {
  return {};
}

/** 逻辑时钟接口（B 端每 tab 一份；单测可注入初始值）。 */
export interface LamportClock {
  /** 当前值。 */
  readonly value: number;
  /** 本地发送前：自增 1 并返回新时间戳。 */
  tick(): number;
  /** 收到远端消息：clock = max(clock, remote) + 1（永不回拨），返回新时间戳。 */
  observe(remote: number): number;
}

/** 创建一个 Lamport 时钟（纯对象，无 Date.now / 无定时器）。 */
export function createLamportClock(initial = 0): LamportClock {
  let v = Math.max(0, Math.floor(initial));
  return {
    get value() {
      return v;
    },
    tick() {
      v = v + 1;
      return v;
    },
    observe(remote: number) {
      const r = Number.isFinite(remote) ? Math.floor(remote) : 0;
      v = Math.max(v, r) + 1;
      return v;
    },
  };
}
