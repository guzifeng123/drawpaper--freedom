import type { KBNoteDoc } from '../model/index.js';
import type { FMarkTuple } from './types.js';

/**
 * 时钟抬升：B 端加载一份 v3 文档后，本端 Lamport 时钟必须 ≥ 文档里已持久化的
 * 最高 lamport，否则本地新编辑会输给迁移/对端旧戳。
 *
 * 纯函数：只扫描 sync 元数据里的数字，不碰 Date.now。
 */

function bumpInto(max: { v: number }, t: FMarkTuple | undefined): void {
  if (t && t[0] > max.v) max.v = t[0];
}

/** 计算一份 v3 文档里已观察到的最高 lamport。 */
export function maxPersistedLamport(doc: KBNoteDoc): number {
  const sync = doc.sync;
  const max = { v: 0 };
  for (const v of Object.values(sync?.vv ?? {})) if (v > max.v) max.v = v;
  for (const t of Object.values(sync?.docF ?? {})) bumpInto(max, t);
  for (const t of Object.values(sync?.pageF ?? {})) bumpInto(max, t);
  for (const meta of Object.values(sync?.nodes ?? {})) {
    bumpInto(max, meta.t);
    if (meta.f) for (const t of Object.values(meta.f)) bumpInto(max, t);
  }
  for (const meta of Object.values(sync?.edges ?? {})) {
    bumpInto(max, meta.t);
    if (meta.f) for (const t of Object.values(meta.f)) bumpInto(max, t);
  }
  return max.v;
}

/**
 * B 端建钟时的初始值：createLamportClock(adoptClockFloor(doc)) 后再 tick()，
 * 保证本地新戳严格大于任何已持久化事件。
 */
export function adoptClockFloor(doc: KBNoteDoc): number {
  return maxPersistedLamport(doc);
}
