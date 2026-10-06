import { useEffect, useRef } from 'react';
import { TextCursorInput, ClipboardPaste, Maximize, Columns2 } from 'lucide-react';

/**
 * PaneContextMenu —— 画布空白处的共享右键/长按上下文菜单。
 *
 * 【Wave14 D】鼠标右键（contextmenu）与触屏长按空白（longpress，粗指针）**共用这同一个菜单**：
 * 两条入口都只是「在屏幕坐标 (x,y) 打开本菜单」，菜单项与动作只有这一份实现，不复制两套。
 *
 * 菜单项：新建文本块 / 粘贴 / 适应屏幕；分页预览模式额外「插入分页符」。
 * 菜单项按钮 ≥44px 触控热区。受控：外部给 open 位置，本组件负责 outside-pointerdown / Esc 关闭。
 */

export interface PaneContextMenuProps {
  /** 屏幕坐标（clientX/clientY）。 */
  x: number;
  y: number;
  /** 分页预览模式：额外显示「插入分页符」。 */
  pageBreakMode: boolean;
  onNewBlock: () => void;
  onPaste: () => void;
  onFit: () => void;
  onInsertPageBreak: () => void;
  onClose: () => void;
}

export const PaneContextMenu = function PaneContextMenu({
  x,
  y,
  pageBreakMode,
  onNewBlock,
  onPaste,
  onFit,
  onInsertPageBreak,
  onClose,
}: PaneContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // outside pointerdown / Esc 关闭。
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // 下一帧再挂监听：避免触发本菜单的那一次 pointerup/down 立刻关掉自己。
    const raf = requestAnimationFrame(() => {
      window.addEventListener('pointerdown', onDown, true);
      window.addEventListener('keydown', onKey, true);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  // 防溢出：菜单高约 220px、宽 200px；贴近右/下边缘时回挪。
  const MENU_W = 208;
  const MENU_H = pageBreakMode ? 220 : 176;
  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_W - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - MENU_H - 8));

  const item =
    'flex h-11 w-full items-center gap-2 px-3 text-left text-sm hover:bg-blue-500/15 rounded-md';

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="pane-context-menu"
      className="fixed z-[9999] min-w-[200px] rounded-lg border bg-[hsl(var(--popover))] p-1.5 text-[hsl(var(--popover-foreground))] shadow-xl"
      style={{ left, top }}
    >
      <button type="button" role="menuitem" data-testid="pane-menu-new-block" className={item} onClick={onNewBlock}>
        <TextCursorInput size={16} /> 新建文本块
      </button>
      <button type="button" role="menuitem" data-testid="pane-menu-paste" className={item} onClick={onPaste}>
        <ClipboardPaste size={16} /> 粘贴
      </button>
      <button type="button" role="menuitem" data-testid="pane-menu-fit" className={item} onClick={onFit}>
        <Maximize size={16} /> 适应屏幕
      </button>
      {pageBreakMode && (
        <button type="button" role="menuitem" data-testid="pane-menu-pagebreak" className={item} onClick={onInsertPageBreak}>
          <Columns2 size={16} /> 在此插入分页符
        </button>
      )}
    </div>
  );
};
