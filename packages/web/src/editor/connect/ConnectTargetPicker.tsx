import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Spline, Search } from 'lucide-react';
import { useEditorApi, useEditorSnapshot } from '../canvas/editor-context';
import { useConnectPickerStore } from './connect-picker-store';
import { filterConnectTargets, connectTargetTitle, type ConnectTargetCandidate } from '../lib/connect-targets';
import { pushToast } from '@/panels/lib/toast';

/**
 * Wave23 纯键盘跨块父子连线 —— 目标块选择器。
 *
 * 由 `c` 键在「选中某块」时打开（见 useKeyboardShortcuts）：源块=当前选中块。
 * 交互仿 doc-embed-picker：
 *  - 键入文字即按标题/正文前缀过滤（纯函数 connect-targets）；
 *  - ↑↓ 在候选间移动高亮，Enter/Tab 确认，Esc 取消；
 *  - 点击外部关闭；IME 组合期让路（isComposing 直接放行）；
 *  - 确认后走与指针拖拽完全相同的校验：CanvasEditor.onConnect（自环/重复边提示 + api.addEdge），
 *    多父/成环由 core addEdge 自动挂起冲突弹窗，撤销栈自动继承。
 *
 * 空态决策：Enter 在无候选时无副作用（不新建子块）；新建并连子块仍走 Tab/Enter 全局建块语义。
 */
export function ConnectTargetPicker({
  onConfirm,
}: {
  /** CanvasInner 注入：等价于 onConnect({source,target})，复用指针路径全部校验。 */
  onConfirm: (sourceId: string, targetId: string) => void;
}) {
  const api = useEditorApi();
  const snap = useEditorSnapshot();
  const { open, sourceId } = useConnectPickerStore();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const doc = snap.doc;
  const closePicker = () => useConnectPickerStore.getState().closePicker();
  const candidates: ConnectTargetCandidate[] = useMemo(
    () => (open && sourceId ? filterConnectTargets(doc, sourceId, query) : []),
    [open, sourceId, doc, query],
  );

  // 关闭：退回 select 模式、不落任何变更。
  const cancel = () => {
    closePicker();
    api.setMode('select');
    pushToast('warn', '已取消连线');
  };

  const confirm = (targetId: string) => {
    if (!sourceId) return;
    // 延迟到当前 keydown 事件之后再落副作用：
    // 否则「同步卸载输入框 + 打开 Radix 冲突弹窗抢焦点」会让同步键盘派发卡住。
    setTimeout(() => {
      const dup = doc.edges.some((e) => e.source === sourceId && e.target === targetId);
      // 复用指针路径校验：onConnect 内部已做自环/重复边 toast + addEdge。
      onConfirm(sourceId, targetId);
      if (!dup) {
        const srcNode = doc.nodes.find((n) => n.id === sourceId);
        const tgtNode = doc.nodes.find((n) => n.id === targetId);
        pushToast(
          'success',
          `已连接 ${srcNode ? connectTargetTitle(srcNode) : sourceId} → ${tgtNode ? connectTargetTitle(tgtNode) : targetId}`,
        );
      }
      closePicker();
      api.setMode('select');
    }, 0);
  };

  // 打开时：聚焦输入、重置查询、播报候选数；源块失效则直接关。
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    if (sourceId && !doc.nodes.some((n) => n.id === sourceId)) {
      closePicker();
      return;
    }
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    const total = sourceId ? filterConnectTargets(doc, sourceId, '').length : 0;
    pushToast('warn', `找到 ${total} 个可连接块`);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 模式被外部切走（工具栏按钮 / v）→ 自动关选择器。
  useEffect(() => {
    if (open && snap.mode !== 'connect') closePicker();
  }, [open, snap.mode]);

  // 键盘导航：↑↓ 移动、Enter/Tab 确认、Esc 取消。IME 组合期放行。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % Math.max(candidates.length, 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + candidates.length) % Math.max(candidates.length, 1));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const c = candidates[active];
        if (c) confirm(c.nodeId);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, candidates, active, sourceId, doc]);

  // 高亮项滚动进可视区。
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-option-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open || !sourceId) return null;

  const activeId = candidates[active] ? `connect-target-opt-${active}` : undefined;

  return createPortal(
    <div>
      {/* 点击外部关闭 */}
      <div className="fixed inset-0 z-40" onMouseDown={cancel} aria-hidden="true" />
      <div
        className="fixed left-1/2 top-1/3 z-50 w-80 -translate-x-1/2 rounded-lg border bg-[hsl(var(--popover))] text-[hsl(var(--popover-foreground))] shadow-xl"
        onMouseDown={(e) => e.preventDefault()}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Spline size={14} className="shrink-0 text-sky-500" />
          <Search size={13} className="shrink-0 text-slate-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="输入目标块标题或正文…"
            role="combobox"
            aria-expanded={candidates.length > 0}
            aria-controls="connect-target-listbox"
            aria-activedescendant={activeId}
            aria-label="连线目标搜索"
            className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
          />
        </div>
        <div ref={listRef} id="connect-target-listbox" role="listbox" aria-label="可连接的目标块" className="max-h-64 overflow-y-auto py-1">
          {candidates.length === 0 && (
            <div className="px-3 py-2 text-xs text-slate-400" role="status">
              无匹配块（自环与后代已自动排除）
            </div>
          )}
          {candidates.map((c, i) => (
            <button
              key={c.nodeId}
              id={`connect-target-opt-${i}`}
              role="option"
              aria-selected={i === active}
              data-option-index={i}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none ${
                i === active ? 'bg-[hsl(var(--accent))] ring-1 ring-inset ring-sky-400' : ''
              }`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => confirm(c.nodeId)}
            >
              <span className="flex-1 truncate">{c.title}</span>
            </button>
          ))}
        </div>
        <div className="border-t px-3 py-1.5 text-[10px] text-slate-400">↑↓ 选择 · Enter 确认 · Esc 取消</div>
      </div>
    </div>,
    document.body,
  );
}
