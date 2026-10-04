import { useMemo } from 'react';
import { ReactFlow, Background, BackgroundVariant, Controls, MiniMap } from '@xyflow/react';
import { Button } from '@/components/ui/button';
import { EDGE_COLORS } from '@drawpaper/core';

/**
 * Wave 0 shell：空 React Flow 画布外壳。
 * - 空 nodes/edges，点阵背景 + Controls + MiniMap。
 * - 顶部占位工具栏。
 * - 不实现任何业务功能；后续 Wave 在此挂载 editor / panels / export。
 */
export default function App() {
  const nodes = useMemo(() => [], []);
  const edges = useMemo(() => [], []);

  // 仅证明 workspace 依赖与 core 契约可被 web 引用（边色常量）。
  void EDGE_COLORS;

  return (
    <div className="relative h-full w-full">
      {/* 顶部占位工具栏 */}
      <header className="absolute left-0 right-0 top-0 z-10 flex h-12 items-center gap-2 border-b bg-white/80 px-3 backdrop-blur">
        <span className="text-sm font-semibold">drawpaper</span>
        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Wave 0 shell</span>
        <div className="ml-3 flex gap-1">
          <Button variant="outline" size="sm" disabled>
            新建
          </Button>
          <Button variant="outline" size="sm" disabled>
            一键整理
          </Button>
          <Button variant="outline" size="sm" disabled>
            导出 PDF
          </Button>
        </div>
      </header>

      {/* 画布外壳：后续 <CanvasShell/> 与各 panel 挂载位 */}
      <div className="absolute inset-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          proOptions={{ hideAttribution: false }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>

      {/* 占位面板区（Wave1-E 挂载位）：文档列表 / 大纲 / 搜索 */}
      <aside className="absolute bottom-4 left-4 z-10 w-48 rounded border bg-white/90 p-2 text-xs text-slate-500">
        panels 挂载位（Wave1-E）
      </aside>
    </div>
  );
}
