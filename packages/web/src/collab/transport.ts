import type { CollabEnvelope } from '@drawpaper/core';
import { serializeEnvelope, parseEnvelope, CollabProtocolError } from '@drawpaper/core';

/**
 * 同浏览器多标签传输层（web 专属；core 零 DOM/网络）。
 *
 * 优先级与降级：
 *  1. BroadcastChannel（同源同浏览器，推荐；不回环给发送方，结构化克隆/JSON 皆可）。
 *  2. window 'storage' 事件 + localStorage 兜底（隐私模式 / 老浏览器无 BroadcastChannel）。
 *  3. 两者皆不可用 → 单标签模式静默降级（transport=disabled，本标签独立编辑，不广播不收）。
 *
 * 铁律：以上三者全部在浏览器进程内闭环，**绝不产生任何 http(s) 网络流量**。
 *
 * 通道命名（v1）：
 *  - 站点级：`drawpaper-collab:v1:site` —— presence / snapshot-request / snapshot（低频；
 *    需要让文档列表知道「哪些 doc 正被其他标签打开」，以及 late-joiner 无需知道持有者是谁）。
 *  - 文档级：`drawpaper-collab:v1:doc:<docId>` —— op 信封（高频；只路由给打开同一文档的标签）。
 */

export type CollabTransportKind = 'broadcast-channel' | 'storage' | 'disabled';

export interface CollabTransport {
  kind: CollabTransportKind;
  /** 发送一条信封（广播到同通道的其他标签；不回环给本标签）。 */
  send(env: CollabEnvelope): void;
  /** 注册消息回调（本标签收到其他标签的信封）。 */
  onMessage(cb: (env: CollabEnvelope) => void): void;
  /** 释放监听/通道。 */
  close(): void;
}

export const SITE_CHANNEL = 'drawpaper-collab:v1:site';
export const docChannel = (docId: string): string => `drawpaper-collab:v1:doc:${docId}`;

/** 能力探测：给定全局对象，决定用哪种传输。纯函数（便于单测注入假全局）。 */
export function detectTransportKind(global: {
  BroadcastChannel?: unknown;
  localStorage?: unknown;
}): CollabTransportKind {
  if (typeof global.BroadcastChannel === 'function') return 'broadcast-channel';
  if (typeof global.localStorage === 'object' && global.localStorage !== null) return 'storage';
  return 'disabled';
}

/** disabled 传输：单标签静默降级（no-op）。 */
function createDisabledTransport(): CollabTransport {
  return {
    kind: 'disabled',
    send() {
      /* 单标签模式：静默丢弃 */
    },
    onMessage() {
      /* 无对端 */
    },
    close() {
      /* no-op */
    },
  };
}

/** BroadcastChannel 传输。 */
function createBroadcastChannelTransport(channelName: string): CollabTransport {
  const ch = new BroadcastChannel(channelName);
  let cb: ((env: CollabEnvelope) => void) | undefined;
  const listener = (ev: MessageEvent) => {
    if (!cb) return;
    try {
      cb(parseEnvelope(ev.data as string));
    } catch (e) {
      if (e instanceof CollabProtocolError) return; // 坏消息丢弃
      throw e;
    }
  };
  ch.addEventListener('message', listener);
  return {
    kind: 'broadcast-channel',
    send(env) {
      ch.postMessage(serializeEnvelope(env));
    },
    onMessage(fn) {
      cb = fn;
    },
    close() {
      ch.removeEventListener('message', listener);
      ch.close();
    },
  };
}

/**
 * storage 事件兜底传输。
 * 每条消息用独立 localStorage 键，避免同步连发互相覆盖；接收方读后即删，控制体积。
 * 'storage' 事件不发往当前标签，天然无回环。
 */
function createStorageTransport(channelName: string): CollabTransport {
  const keyPrefix = `drawpaper-collab:v1:msg:${channelName}:`;
  let cb: ((env: CollabEnvelope) => void) | undefined;
  let counter = 0;
  const listener = (ev: StorageEvent) => {
    if (!cb || !ev.key || !ev.key.startsWith(keyPrefix)) return;
    if (ev.newValue == null) return;
    try {
      cb(parseEnvelope(ev.newValue));
    } catch (e) {
      if (e instanceof CollabProtocolError) return;
      throw e;
    } finally {
      try {
        localStorage.removeItem(ev.key);
      } catch {
        /* 配额/隐私模式：忽略 */
      }
    }
  };
  window.addEventListener('storage', listener);
  return {
    kind: 'storage',
    send(env) {
      try {
        const key = `${keyPrefix}${Date.now().toString(36)}:${(counter++).toString(36)}`;
        localStorage.setItem(key, serializeEnvelope(env));
      } catch {
        /* 存储不可写：降级丢弃（不阻塞编辑） */
      }
    },
    onMessage(fn) {
      cb = fn;
    },
    close() {
      window.removeEventListener('storage', listener);
    },
  };
}

/** 工厂：按能力探测结果创建一个通道的传输。 */
export function createTransport(channelName: string): CollabTransport {
  const kind = detectTransportKind(
    typeof window !== 'undefined'
      ? (window as unknown as { BroadcastChannel?: unknown; localStorage?: unknown })
      : { BroadcastChannel: undefined, localStorage: undefined },
  );
  switch (kind) {
    case 'broadcast-channel':
      return createBroadcastChannelTransport(channelName);
    case 'storage':
      return createStorageTransport(channelName);
    default:
      return createDisabledTransport();
  }
}
