import { describe, expect, it } from 'vitest';
import {
  initialGestureState,
  reduceGesture,
  DEFAULT_GESTURE_CONFIG,
  type GestureState,
  type GestureEvent,
  type GestureIntent,
} from './gesture';

function run(events: GestureEvent[], cfg = DEFAULT_GESTURE_CONFIG): { final: GestureState; intents: GestureIntent[] } {
  let s = initialGestureState();
  const all: GestureIntent[] = [];
  for (const ev of events) {
    const r = reduceGesture(s, ev, cfg);
    s = r.state;
    all.push(...r.intents);
  }
  return { final: s, intents: all };
}

describe('gesture 状态机', () => {
  it('静止快速抬起 = tap', () => {
    const { intents } = run([
      { type: 'down', id: 1, kind: 'touch', x: 100, y: 100, time: 0 },
      { type: 'up', id: 1, x: 100, y: 100, time: 50 },
    ]);
    expect(intents).toEqual([{ type: 'tap', id: 1, x: 100, y: 100 }]);
  });

  it('间隔短且位置近 = double-tap', () => {
    const { intents } = run([
      { type: 'down', id: 1, kind: 'touch', x: 100, y: 100, time: 0 },
      { type: 'up', id: 1, x: 100, y: 100, time: 60 },
      { type: 'down', id: 1, kind: 'touch', x: 105, y: 100, time: 200 },
      { type: 'up', id: 1, x: 105, y: 100, time: 240 },
    ]);
    expect(intents.map((i) => i.type)).toEqual(['tap', 'double-tap']);
  });

  it('间隔过长 = 两次独立 tap', () => {
    const { intents } = run([
      { type: 'down', id: 1, kind: 'touch', x: 100, y: 100, time: 0 },
      { type: 'up', id: 1, x: 100, y: 100, time: 60 },
      { type: 'down', id: 1, kind: 'touch', x: 100, y: 100, time: 1000 },
      { type: 'up', id: 1, x: 100, y: 100, time: 1060 },
    ]);
    expect(intents.filter((i) => i.type === 'tap').length).toBe(2);
  });

  it('静止到点 = longpress，之后抬起不再发 tap', () => {
    const { intents } = run([
      { type: 'down', id: 1, kind: 'touch', x: 100, y: 100, time: 0 },
      { type: 'longpress-check', id: 1, time: 500 },
      { type: 'up', id: 1, x: 100, y: 100, time: 520 },
    ]);
    expect(intents.map((i) => i.type)).toEqual(['longpress']);
  });

  it('超过位移阈值 = drag-start + drag-move', () => {
    const { intents } = run([
      { type: 'down', id: 1, kind: 'touch', x: 100, y: 100, time: 0 },
      { type: 'move', id: 1, x: 120, y: 100, time: 20 },
      { type: 'move', id: 1, x: 140, y: 100, time: 40 },
    ]);
    const types = intents.map((i) => i.type);
    expect(types[0]).toBe('drag-start');
    expect(types.filter((t) => t === 'drag-move').length).toBeGreaterThan(0);
  });

  it('小幅度移动未过阈值，到点仍可 longpress', () => {
    const { intents } = run([
      { type: 'down', id: 1, kind: 'touch', x: 100, y: 100, time: 0 },
      { type: 'move', id: 1, x: 103, y: 100, time: 10 },
      { type: 'longpress-check', id: 1, time: 500 },
    ]);
    expect(intents.some((i) => i.type === 'longpress')).toBe(true);
  });

  it('第二指落下 = pinch-start，移动 = pinch-move（带 scale）', () => {
    const { intents } = run([
      { type: 'down', id: 1, kind: 'touch', x: 0, y: 0, time: 0 },
      { type: 'down', id: 2, kind: 'touch', x: 100, y: 0, time: 10 },
      { type: 'move', id: 2, x: 200, y: 0, time: 20 },
    ]);
    expect(intents[0]).toEqual({ type: 'pinch-start', dist: 100 });
    const pm = intents.find((i) => i.type === 'pinch-move');
    expect(pm?.type).toBe('pinch-move');
    if (pm?.type === 'pinch-move') expect(pm.scale).toBeCloseTo(2, 1);
  });

  it('cancel 清理指针', () => {
    const { final } = run([
      { type: 'down', id: 1, kind: 'touch', x: 0, y: 0, time: 0 },
      { type: 'cancel', id: 1 },
    ]);
    expect(final.phase).toBe('idle');
    expect(final.pointers.size).toBe(0);
  });
});
