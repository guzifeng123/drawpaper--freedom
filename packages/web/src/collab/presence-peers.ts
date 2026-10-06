import type { ClientId, PresenceState } from '@drawpaper/core';

/**
 * 远端 peer 表 + 心跳超时判定（纯函数，便于单测注入时钟）。
 *
 * 一个 Peer = 打开同一站点任意文档的其他标签：身份 + 最新现场 + 最后见到心跳的时间。
 * 心跳超时（默认 3500ms；心跳发送间隔 1000ms）后判离线并清除——含标签异常关闭
 * （崩溃/直接关窗不会发 goodbye），完全靠「心跳不再到达」来推断。
 */

export interface Peer {
  clientId: ClientId;
  name: string;
  color: string;
  /** 该 peer 当前打开的 docId。 */
  docId: string;
  presence: PresenceState;
  /** 最后一次收到该 peer 任意信封的本地时间（performance.now / 注入时钟）。 */
  lastSeenAt: number;
}

export const DEFAULT_HEARTBEAT_MS = 1000;
export const DEFAULT_PRESENCE_TIMEOUT_MS = 3500;

/** 用一条 presence 信封 upsert 一个 peer；返回新表（不可变）。 */
export function upsertPeer(
  table: Map<ClientId, Peer>,
  fields: {
    clientId: ClientId;
    name: string;
    color: string;
    presence: PresenceState;
    now: number;
  },
): Map<ClientId, Peer> {
  const next = new Map(table);
  next.set(fields.clientId, {
    clientId: fields.clientId,
    name: fields.name,
    color: fields.color,
    docId: fields.presence.docId,
    presence: fields.presence,
    lastSeenAt: fields.now,
  });
  return next;
}

/**
 * 扫表，移除 `now - lastSeenAt > timeoutMs` 的离线 peer。
 * 返回 { table, removed }（removed 便于 UI/日志）。纯函数。
 */
export function sweepOfflinePeers(
  table: Map<ClientId, Peer>,
  now: number,
  timeoutMs: number,
): { table: Map<ClientId, Peer>; removed: Peer[] } {
  const removed: Peer[] = [];
  const next = new Map<ClientId, Peer>();
  for (const [id, peer] of table) {
    if (now - peer.lastSeenAt > timeoutMs) removed.push(peer);
    else next.set(id, peer);
  }
  return { table: next, removed };
}

/** 过滤出正在打开指定 docId 的远端 peer（用于本文档在线点 / 选区高亮）。 */
export function peersForDoc(table: Map<ClientId, Peer>, docId: string): Peer[] {
  return [...table.values()].filter((p) => p.docId === docId);
}

/**
 * 站点级「文档 → 打开它的远端 peer 列表」（供文档列表显示「已在其他标签打开」咨询标记）。
 * 不含本端自己。
 */
export function docsOpenByPeers(
  table: Map<ClientId, Peer>,
): Map<string, Array<{ clientId: ClientId; name: string; color: string }>> {
  const out = new Map<string, Array<{ clientId: ClientId; name: string; color: string }>>();
  for (const p of table.values()) {
    const arr = out.get(p.docId) ?? [];
    arr.push({ clientId: p.clientId, name: p.name, color: p.color });
    out.set(p.docId, arr);
  }
  return out;
}
