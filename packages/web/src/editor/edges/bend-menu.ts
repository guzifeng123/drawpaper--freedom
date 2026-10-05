/**
 * 右键锚点弹出的小菜单状态（模块级单例，避免 ParentEdge 重挂载丢 state）。
 * 由 ParentEdge 读取/写入；菜单渲染在该 EdgeLabelRenderer 内。
 */
export interface BendMenuState {
  edgeId: string;
  index: number;
  x: number;
  y: number;
}

let current: BendMenuState | null = null;
const listeners = new Set<() => void>();

export function getBendMenu(): BendMenuState | null {
  return current;
}

export function setBendMenu(next: BendMenuState | null): void {
  current = next;
  listeners.forEach((fn) => fn());
}

export function subscribeBendMenu(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
