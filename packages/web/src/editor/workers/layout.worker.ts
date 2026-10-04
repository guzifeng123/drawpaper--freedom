/// <reference lib="webworker" />
/**
 * layout.worker.ts —— 可选的离线程布局（Wave3-I，不强制接线）。
 *
 * 用法（Wave4 决定是否启用）：
 *   const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
 *   worker.postMessage({ input, mode });
 *   worker.onmessage = (e) => setLayoutResult(e.data);
 *
 * 把 core layoutTree 搬出主线程，避免大导图整理时阻塞 UI。
 * store/布局 agent 接线；editor 仅提供开关式助手与文档。
 */
import { layoutTree, type LayoutInput, type LayoutMode, type LayoutResult } from '@drawpaper/core';

export interface LayoutRequest {
  input: LayoutInput;
  mode: LayoutMode;
}

export type LayoutResponse = LayoutResult;

self.onmessage = (ev: MessageEvent<LayoutRequest>) => {
  const { input, mode } = ev.data;
  const result = layoutTree(input, mode);
  (self as unknown as Worker).postMessage(result);
};
