import { memo, useRef, useState } from 'react';
import { Handle, Position, useReactFlow, type HandleProps } from '@xyflow/react';
import { useEditorApi } from '../canvas/editor-context';

/**
 * ConnectHandle —— 带「长按起连线」的连接点（§4.6 触屏攻关）。
 *
 * - 鼠标：行为与 RF `<Handle>` 完全一致（按下即拖连）。
 * - 触摸：pointerdown 先拦截（阻止 RF 原生触控拖拽/平移抢手势），
 *   静止按住 500ms（navigator.vibrate(15) 触觉反馈）才进入「连线中」，
 *   随后手指拖动 = 一根跟随线；松手命中目标块 → addEdge，命中空白 → 建子块。
 *   500ms 内移动超阈值则取消（退化为普通平移/拖块）。
 *
 * 连接判定为自包含实现（elementFromPoint 命中 .react-flow__node[data-id]），
 * 不依赖 RF 内部 store，稳定可测；易 flaky 的时序已下沉 gesture 纯函数单测。
 * 热区 ≥44px 由 editor-theme.css 保证。
 */

interface ConnectHandleProps extends Omit<HandleProps, 'nodeId'> {
  nodeId: string;
}

export const ConnectHandle = memo(function ConnectHandle({ nodeId, ...rest }: ConnectHandleProps) {
  const api = useEditorApi();
  const rf = useReactFlow();
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const [connecting, setConnecting] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch') return; // 鼠标走 RF 原生
    const kind = rest.type; // 'source' 或 'target'
    if (kind !== 'source' && kind !== 'target') return;
    e.preventDefault();
    e.stopPropagation();
    const rect = ref.current?.getBoundingClientRect();
    start.current = {
      x: e.clientX,
      y: e.clientY,
      cx: rect ? rect.left + rect.width / 2 : e.clientX,
      cy: rect ? rect.top + rect.height / 2 : e.clientY,
    };
    let fired = false;
    timer.current = setTimeout(() => {
      fired = true;
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(15);
      setConnecting({ x1: start.current!.cx, y1: start.current!.cy, x2: e.clientX, y2: e.clientY });
    }, 500);

    const onMove = (ev: PointerEvent) => {
      const s = start.current;
      if (!s) return;
      const dx = ev.clientX - s.x;
      const dy = ev.clientY - s.y;
      if (!fired && Math.hypot(dx, dy) > 8) {
        // 500ms 内移动 = 用户想平移/拖块，取消长按
        clearTimer();
        cleanup();
        return;
      }
      if (fired) setConnecting({ x1: s.cx, y1: s.cy, x2: ev.clientX, y2: ev.clientY });
    };
    const onUp = (ev: PointerEvent) => {
      cleanup();
      clearTimer();
      if (!fired) {
        start.current = null;
        return;
      }
      setConnecting(null);
      // 命中目标节点
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-id]');
      const otherId = el?.getAttribute('data-id');
      if (kind === 'source') {
        if (otherId && otherId !== nodeId) {
          // 与既有 onConnect 一致的自环/重复校验由 store addEdge 处理
          api.addEdge(nodeId, otherId);
        } else if (!otherId) {
          // 松手空白：在 flow 坐标建子块并连父子
          const pos = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
          const childId = api.addNode('text', pos.x - 110, pos.y - 30);
          api.addEdge(nodeId, childId);
        }
      } else if (kind === 'target') {
        // 长按本 target 块（子），拖到某 source 块（父）松手 → addEdge(父, 本块)
        if (otherId && otherId !== nodeId) {
          api.addEdge(otherId, nodeId);
        }
        // 拖到空白 = 取消（不建块、不连）
      }
      start.current = null;
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return (
    <>
      <Handle
        {...rest}
        ref={ref}
        onPointerDownCapture={onPointerDown}
        className={`${rest.className ?? ''} touch-manipulation`}
      />
      {connecting && (
        <svg
          className="pointer-events-none fixed left-0 top-0 z-[9999]"
          width="100vw"
          height="100vh"
          style={{ position: 'fixed' }}
        >
          <line
            x1={connecting.x1}
            y1={connecting.y1}
            x2={connecting.x2}
            y2={connecting.y2}
            stroke="#3b82f6"
            strokeWidth={2}
            strokeDasharray="5 4"
          />
          <circle cx={connecting.x2} cy={connecting.y2} r={5} fill="#3b82f6" />
        </svg>
      )}
    </>
  );
});

/** 供 BlockShell 使用的便捷封装：source 右/下两点。
 *  P2.1：显式 id 与 position 同名，ReactFlow v12 才能按 edge.sourceHandle 匹配到手柄（否则 error#008 不渲染边）。 */
export function SourceHandles({ nodeId }: { nodeId: string }) {
  return (
    <>
      <ConnectHandle nodeId={nodeId} id="right" type="source" position={Position.Right} className="!h-2 !w-2 !bg-slate-400" />
      <ConnectHandle nodeId={nodeId} id="bottom" type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-slate-400" />
    </>
  );
}

/** 供 BlockShell 使用的便捷封装：target 左/上两点（长按入连）。 */
export function TargetHandles({ nodeId }: { nodeId: string }) {
  return (
    <>
      <ConnectHandle nodeId={nodeId} id="left" type="target" position={Position.Left} className="!h-2 !w-2 !bg-slate-400" />
      <ConnectHandle nodeId={nodeId} id="top" type="target" position={Position.Top} className="!h-2 !w-2 !bg-slate-400" />
    </>
  );
}
