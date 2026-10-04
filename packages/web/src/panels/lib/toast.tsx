import * as React from 'react';
import { create } from 'zustand';
import { CheckCircle2, AlertTriangle, XCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 自研轻量 toast（环境未装 @radix-ui/react-toast / sonner）。
 * - zustand 小 store 持有队列；<Toaster/> 视口内渲染。
 * - Wave2 由 App 挂一次 <Toaster/>；业务侧用 useToast()。
 */

export type ToastKind = 'success' | 'warn' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastStore {
  toasts: ToastItem[];
  push: (kind: ToastKind, message: string, durationMs?: number) => void;
  dismiss: (id: number) => void;
  /** 测试用：清空队列。 */
  reset: () => void;
}

let nextId = 1;

const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (kind, message, durationMs = 2600) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    if (durationMs > 0) {
      setTimeout(() => get().dismiss(id), durationMs);
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  reset: () => set({ toasts: [] }),
}));

/** 业务侧调用：const toast = useToast(); toast.success('已保存')。 */
export function useToast() {  const push = useToastStore((s) => s.push);
  return React.useMemo(
    () => ({
      success: (message: string, durationMs?: number) => push('success', message, durationMs),
      warn: (message: string, durationMs?: number) => push('warn', message, durationMs),
      error: (message: string, durationMs?: number) => push('error', message, durationMs),
    }),
    [push],
  );
}

const KIND_STYLE: Record<ToastKind, string> = {
  success: 'border-l-4 border-l-success bg-white text-foreground shadow-lg',
  warn: 'border-l-4 border-l-warning bg-white text-foreground shadow-lg',
  error: 'border-l-4 border-l-destructive bg-white text-foreground shadow-lg',
};

function KindIcon({ kind }: { kind: ToastKind }) {
  if (kind === 'success') return <CheckCircle2 className="h-4 w-4 text-success" />;
  if (kind === 'warn') return <AlertTriangle className="h-4 w-4 text-warning" />;
  return <XCircle className="h-4 w-4 text-destructive" />;
}

/** 视口容器：挂一次即可。 */
export function Toaster() {  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            'pointer-events-auto flex items-center gap-2 rounded-md border px-3 py-2 text-sm animate-slide-in-from-right-2',
            KIND_STYLE[t.kind],
          )}
        >
          <KindIcon kind={t.kind} />
          <span className="flex-1">{t.message}</span>
          <button
            type="button"
            aria-label="关闭提示"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => dismiss(t.id)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** 测试用：清空 toast 队列。 */
export function __resetToasts() {
  useToastStore.getState().reset();
}

/** 非 React 侧（适配层 / 快捷键）直接 push 一条 toast。 */
export function pushToast(kind: ToastKind, message: string, durationMs?: number): void {
  useToastStore.getState().push(kind, message, durationMs);
}
