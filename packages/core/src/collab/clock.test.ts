import { describe, it, expect } from 'vitest';
import {
  createLamportClock,
  compareEvents,
  lwwBeats,
  compareVersions,
  mergeVersions,
  emptyVersionVector,
} from './clock.js';

describe('Lamport 时钟', () => {
  it('tick 单调自增', () => {
    const c = createLamportClock(0);
    expect(c.tick()).toBe(1);
    expect(c.tick()).toBe(2);
    expect(c.value).toBe(2);
  });

  it('observe 旧时间戳不会让时钟回拨，只自增 1', () => {
    const c = createLamportClock(10);
    expect(c.observe(3)).toBe(11); // max(10,3)+1
    expect(c.observe(0)).toBe(12);
    expect(c.value).toBe(12);
  });

  it('observe 远端领先时向前跳变', () => {
    const c = createLamportClock(1);
    expect(c.observe(100)).toBe(101);
    expect(c.tick()).toBe(102);
  });

  it('非法 remote 视为 0，不抛错', () => {
    const c = createLamportClock(5);
    expect(c.observe(Number.NaN)).toBe(6);
    expect(c.observe(Number.POSITIVE_INFINITY)).toBe(7);
  });
});

describe('事件全序与 LWW 裁决', () => {
  it('Lamport 大者胜', () => {
    expect(lwwBeats({ lamport: 5, clientId: 'b' }, { lamport: 4, clientId: 'a' })).toBe(true);
    expect(lwwBeats({ lamport: 4, clientId: 'a' }, { lamport: 5, clientId: 'b' })).toBe(false);
  });

  it('同 Lamport（同帧并发）：clientId 字典序小者胜（确定性）', () => {
    expect(lwwBeats({ lamport: 5, clientId: 'a' }, { lamport: 5, clientId: 'b' })).toBe(true);
    expect(lwwBeats({ lamport: 5, clientId: 'b' }, { lamport: 5, clientId: 'a' })).toBe(false);
  });

  it('compareEvents 与 lwwBeats 一致', () => {
    expect(compareEvents({ lamport: 5, clientId: 'a' }, { lamport: 5, clientId: 'b' })).toBe(1);
    expect(compareEvents({ lamport: 3, clientId: 'z' }, { lamport: 5, clientId: 'a' })).toBe(-1);
    expect(compareEvents({ lamport: 7, clientId: 'x' }, { lamport: 7, clientId: 'x' })).toBe(0);
  });
});

describe('版本向量', () => {
  it('before / after / equal / concurrent', () => {
    expect(compareVersions({ a: 1 }, { a: 2, b: 1 })).toBe('before');
    expect(compareVersions({ a: 2, b: 1 }, { a: 1 })).toBe('after');
    expect(compareVersions({ a: 1, b: 1 }, { a: 1, b: 1 })).toBe('equal');
    expect(compareVersions({ a: 2 }, { b: 2 })).toBe('concurrent');
  });

  it('mergeVersions 逐分量取 max', () => {
    expect(mergeVersions({ a: 1, b: 3 }, { a: 2, c: 5 })).toEqual({ a: 2, b: 3, c: 5 });
    expect(emptyVersionVector()).toEqual({});
  });
});
