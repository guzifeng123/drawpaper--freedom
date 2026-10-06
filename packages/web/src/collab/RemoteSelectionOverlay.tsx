import { useCollabUi } from './collab-ui-store';
import { useEditorStore } from '@/store';

/**
 * 远端选区 / 飞块高亮（纯只读装饰，不抢焦点、不交互）。
 *
 * 对每个打开本文档的远端 peer：其 presence.selection 中的节点画该 peer 颜色的描边框，
 * hoverNodeId 画半透明高亮。世界坐标 → 屏幕坐标按 viewport(zoom,x,y) 折算。
 */
export function RemoteSelectionOverlay() {
  const peers = useCollabUi((s) => s.peers);
  const doc = useEditorStore((s) => s.doc);
  const viewport = useEditorStore((s) => s.viewport);

  if (peers.length === 0) return null;
  const { zoom, x: vx, y: vy } = viewport;
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));

  return (
    <div className="pointer-events-none absolute inset-0 z-[6] overflow-hidden">
      {peers.map((p) => {
        const ids = new Set(p.presence.selection);
        if (p.presence.hoverNodeId) ids.add(p.presence.hoverNodeId);
        return [...ids].map((nodeId) => {
          const n = nodeById.get(nodeId);
          if (!n) return null;
          const hovered = p.presence.hoverNodeId === nodeId;
          return (
            <div
              key={`${p.clientId}:${nodeId}`}
              data-remote-selection={p.clientId}
              className="absolute rounded-sm"
              style={{
                left: n.x * zoom + vx,
                top: n.y * zoom + vy,
                width: n.width * zoom,
                height: n.height * zoom,
                border: `2px solid ${p.color}`,
                background: hovered ? `${p.color}22` : 'transparent',
                boxShadow: `0 0 0 1px ${p.color}55`,
              }}
            />
          );
        });
      })}
    </div>
  );
}
