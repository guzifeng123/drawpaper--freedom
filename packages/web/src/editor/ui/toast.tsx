import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * 轻提示 toast（editor 内部自管，不依赖面板）。
 * 用法：toast('自环禁止')；<ToastHost/> 挂一次即可。
 */

interface ToastItem {
  id: number;
  message: string;
}

let nextId = 1;
type Listener = (items: ToastItem[]) => void;
const items: ToastItem[] = [];
const listeners = new Set<Listener>();

export function toast(message: string): void {
  const item = { id: nextId++, message };
  items.push(item);
  emit();
  setTimeout(() => {
    const i = items.findIndex((t) => t.id === item.id);
    if (i >= 0) items.splice(i, 1);
    emit();
  }, 1800);
}

function emit(): void {
  for (const l of listeners) l([...items]);
}

export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>([]);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return createPortal(
    <div className="pointer-events-none absolute left-1/2 top-14 z-[1000] flex -translate-x-1/2 flex-col items-center gap-1">
      {list.map((t) => (
        <div key={t.id} className="rounded-full bg-slate-800/90 px-3 py-1 text-xs text-white shadow">
          {t.message}
        </div>
      ))}
    </div>,
    document.body,
  );
}
