/**
 * gesture.ts —— Pointer Events 统一手势判定（纯函数状态机，vitest 全覆盖）。
 *
 * 统一鼠标/触摸/手写笔（Pointer Events 一套代码）。组件持有本状态：
 *  - 收到 pointerdown/move/up/cancel → reduceGesture(...) 得到新状态 + 意图事件；
 *  - 组件自己起 500ms 定时器：到时若仍是「静止 tracking」则派发 `longpress-check`。
 *
 * 意图：tap / double-tap / longpress / drag-start / drag-move / pinch-start / pinch-move。
 * 平移（pan）在单指且未触发 longpress/drag 边界时由 React Flow 原生处理，
 * 本状态机只在「明确是拖拽块」时发 drag-*，避免与 RF 抢手势。
 */

export interface GesturePt {
  x: number;
  y: number;
}

export interface TrackedPointer {
  id: number;
  kind: 'mouse' | 'touch' | 'pen';
  start: GesturePt;
  last: GesturePt;
}

export interface GestureConfig {
  /** 长按触发毫秒（默认 500，§4.6）。 */
  longpressMs: number;
  /** 超过该位移即判定为拖拽（px）。 */
  movePx: number;
  /** 双击判定窗口毫秒。 */
  doubleTapMs: number;
  /** 双击命中距离（px）。 */
  doubleTapSlopPx: number;
}

export const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  longpressMs: 500,
  movePx: 8,
  doubleTapMs: 300,
  doubleTapSlopPx: 24,
};

export type GesturePhase = 'idle' | 'tracking' | 'longpress' | 'drag' | 'pinch';

export interface GestureState {
  pointers: Map<number, TrackedPointer>;
  phase: GesturePhase;
  /** 主指针（第一个按下的）id。 */
  primaryId: number | null;
  /** 主指针是否已越过 movePx 阈值（开始拖拽）。 */
  moved: boolean;
  /** 长按是否已触发（用于静止时到点发 longpress）。 */
  longpressFired: boolean;
  /** 双指捏合起始距离。 */
  pinchDist: number;
  lastTapAt: number;
  lastTapPos: GesturePt | null;
}

export function initialGestureState(): GestureState {
  return {
    pointers: new Map(),
    phase: 'idle',
    primaryId: null,
    moved: false,
    longpressFired: false,
    pinchDist: 0,
    lastTapAt: 0,
    lastTapPos: null,
  };
}

export type GestureEvent =
  | { type: 'down'; id: number; kind: TrackedPointer['kind']; x: number; y: number; time: number }
  | { type: 'move'; id: number; x: number; y: number; time: number }
  | { type: 'up'; id: number; x: number; y: number; time: number }
  | { type: 'cancel'; id: number }
  | { type: 'longpress-check'; id: number; time: number };

export type GestureIntent =
  | { type: 'tap'; id: number; x: number; y: number }
  | { type: 'double-tap'; x: number; y: number }
  | { type: 'longpress'; id: number; x: number; y: number }
  | { type: 'drag-start'; id: number }
  | { type: 'drag-move'; id: number; dx: number; dy: number }
  | { type: 'pinch-start'; dist: number }
  | { type: 'pinch-move'; scale: number; center: GesturePt };

function dist(a: GesturePt, b: GesturePt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pairCenter(pa: GesturePt, pb: GesturePt): GesturePt {
  return { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
}

export interface ReduceResult {
  state: GestureState;
  intents: GestureIntent[];
}

/** 纯归约：喂入一个指针事件，返回新状态与产生的意图列表。 */
export function reduceGesture(
  cur: GestureState,
  ev: GestureEvent,
  cfg: GestureConfig = DEFAULT_GESTURE_CONFIG,
): ReduceResult {
  const intents: GestureIntent[] = [];
  const s: GestureState = {
    ...cur,
    pointers: new Map(cur.pointers),
    lastTapAt: cur.lastTapAt,
    lastTapPos: cur.lastTapPos ? { ...cur.lastTapPos } : null,
  };

  switch (ev.type) {
    case 'down': {
      const pt: TrackedPointer = { id: ev.id, kind: ev.kind, start: { x: ev.x, y: ev.y }, last: { x: ev.x, y: ev.y } };
      s.pointers.set(ev.id, pt);
      if (s.pointers.size === 1) {
        s.primaryId = ev.id;
        s.phase = 'tracking';
        s.moved = false;
        s.longpressFired = false;
      } else if (s.pointers.size === 2) {
        // 第二指落下：进入捏合（先于任何单指拖拽判定）
        const vals = [...s.pointers.values()];
        const a = vals[0];
        const b = vals[1];
        if (a && b) {
          s.pinchDist = dist(a.start, b.start);
          s.phase = 'pinch';
          intents.push({ type: 'pinch-start', dist: s.pinchDist });
        }
      }
      // >=3 指：忽略（不改变状态）
      break;
    }

    case 'move': {
      const pt = s.pointers.get(ev.id);
      if (!pt) break;
      const prevLast = { ...pt.last };
      pt.last = { x: ev.x, y: ev.y };
      s.pointers.set(ev.id, pt);

      if (s.phase === 'pinch') {
        const vals = [...s.pointers.values()];
        const a = vals[0];
        const b = vals[1];
        if (a && b) {
          const d = dist(a.last, b.last);
          if (s.pinchDist > 0) {
            intents.push({ type: 'pinch-move', scale: d / s.pinchDist, center: pairCenter(a.last, b.last) });
          }
        }
        break;
      }

      if (ev.id !== s.primaryId) break;
      // 单指：判定是否越过拖拽阈值
      if (!s.moved) {
        const d = dist(pt.start, pt.last);
        if (d > cfg.movePx) {
          s.moved = true;
          if (s.phase === 'tracking') {
            s.phase = 'drag';
            intents.push({ type: 'drag-start', id: ev.id });
          }
        }
      }
      if (s.moved || s.phase === 'drag') {
        intents.push({ type: 'drag-move', id: ev.id, dx: pt.last.x - prevLast.x, dy: pt.last.y - prevLast.y });
      }
      break;
    }

    case 'longpress-check': {
      // 组件在 longpressMs 后派发：若主指静止未动，则触发长按
      if (ev.id !== s.primaryId) break;
      if (s.phase !== 'tracking' || s.moved || s.longpressFired) break;
      const pt = s.pointers.get(ev.id);
      if (!pt) break;
      s.longpressFired = true;
      s.phase = 'longpress';
      intents.push({ type: 'longpress', id: ev.id, x: pt.start.x, y: pt.start.y });
      break;
    }

    case 'up':
    case 'cancel': {
      const wasPinch = s.phase === 'pinch';
      const pt = s.pointers.get(ev.id);
      const upTime = ev.type === 'up' ? ev.time : 0;

      if (ev.type === 'up' && pt && ev.id === s.primaryId && !wasPinch) {
        if (!s.moved && !s.longpressFired) {
          // 静止抬起 = tap；判定双击
          const pos = { x: ev.x, y: ev.y };
          const isDouble =
            s.lastTapAt > 0 &&
            upTime - s.lastTapAt <= cfg.doubleTapMs &&
            s.lastTapPos &&
            dist(pos, s.lastTapPos) <= cfg.doubleTapSlopPx;
          if (isDouble) {
            intents.push({ type: 'double-tap', x: ev.x, y: ev.y });
            s.lastTapAt = 0;
            s.lastTapPos = null;
          } else {
            intents.push({ type: 'tap', id: ev.id, x: ev.x, y: ev.y });
            s.lastTapAt = upTime;
            s.lastTapPos = pos;
          }
        }
        // longpress 抬起：长按已发，这里不再发 tap
      }

      s.pointers.delete(ev.id);
      if (s.pointers.size === 0) {
        s.phase = 'idle';
        s.primaryId = null;
        s.moved = false;
        s.longpressFired = false;
        s.pinchDist = 0;
      } else if (wasPinch) {
        // 捏合后剩一指：以当前位置重新开始 tracking（避免跳变）
        const remaining = [...s.pointers.values()][0]!;
        remaining.start = { ...remaining.last };
        s.pointers.set(remaining.id, remaining);
        s.primaryId = remaining.id;
        s.phase = 'tracking';
        s.moved = false;
        s.longpressFired = false;
        s.pinchDist = 0;
      }
      break;
    }
  }

  return { state: s, intents };
}
