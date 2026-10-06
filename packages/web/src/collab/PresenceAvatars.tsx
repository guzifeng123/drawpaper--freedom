import { useState } from 'react';
import { useCollabUi } from './collab-ui-store';
import { collabManager } from './collab-manager';

/**
 * 顶部在线点条：显示当前文档的远端标签（颜色圆 + 可编辑名称）。
 * 本端名称可改（改名即广播，其他标签看到新名）。
 * transport=disabled（单标签降级）时不渲染。
 */
export function PresenceAvatars() {
  const peers = useCollabUi((s) => s.peers);
  const identity = useCollabUi((s) => s.identity);
  const transportKind = useCollabUi((s) => s.transportKind);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(identity?.name ?? '');

  if (transportKind === 'disabled') return null;
  if (!identity) return null;

  const commitName = () => {
    collabManager.renameTab(name);
    setEditing(false);
  };

  return (
    <div className="absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-full border bg-background/90 px-2 py-1 shadow" data-testid="collab-presence">
      {/* 远端在线标签 */}
      {peers.map((p) => (
        <span
          key={p.clientId}
          className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px]"
          style={{ boxShadow: `inset 0 0 0 1.5px ${p.color}` }}
          title={`${p.name} 正在编辑本文档`}
        >
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="max-w-[80px] truncate">{p.name}</span>
        </span>
      ))}
      {/* 本端（可改名） */}
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="h-5 w-24 rounded border bg-background px-1 text-[11px]"
          data-testid="collab-self-name-input"
        />
      ) : (
        <button
          type="button"
          title="本端标签（点击改名）"
          onClick={() => {
            setName(identity.name);
            setEditing(true);
          }}
          className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px]"
          style={{ boxShadow: `inset 0 0 0 1.5px ${identity.color}` }}
        >
          <span className="h-2 w-2 rounded-full" style={{ background: identity.color }} />
          <span className="max-w-[80px] truncate">{identity.name}（我）</span>
        </button>
      )}
    </div>
  );
}
