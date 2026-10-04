import { useMemo } from 'react';
import { editorStore, conflictBridge } from '@/store/editor-store';
import { useEditorStore } from '@/store';
import { createEditorApi } from '@/wiring/create-editor-api';
import { createPanelsApi } from '@/wiring/create-panels-api';
import { useWiringUi } from '@/wiring/ui-store';
import { CanvasEditor } from '@/editor/canvas/CanvasEditor';
import { TopToolbar } from '@/panels/TopToolbar';
import { DocsListPanel } from '@/panels/DocsListPanel';
import { SearchPanel } from '@/panels/SearchPanel';
import { Toaster } from '@/panels/lib/toast';
import {
  ExportDialog,
  PageBreakOverlay,
  PrintSheets,
  useExportModel,
  computePanelsPaginate,
} from '@/export';

/**
 * App 总装（Wave2）：把真实 EditorStore 经 wiring 适配层接到画布 EditorApi 与面板 PanelsApi。
 *
 * - CanvasEditor 拿真实 EditorApi（state 切片 + 回调 + ConflictBridge）；
 * - TopToolbar / DocsListPanel / SearchPanel 拿 PanelsApi；
 * - useExportModel 接真实 layout/paginate 数据流，三按钮端到端打通；
 * - App 订阅 store 切片以驱动面板重渲染（PanelsApi 是读时 getter）。
 */
export default function App() {
  // editorApi 必须稳定（useSyncExternalStore 要求 subscribe 引用不变）；
  // panelsApi 每次渲染重建——其 getters 读最新 store，新引用驱动 memo 面板重渲染。
  const editorApi = useMemo(() => createEditorApi(editorStore, conflictBridge), []);
  const panelsApi = createPanelsApi(editorStore);

  // 订阅驱动面板重渲染的切片（getter 在渲染期读最新值）。
  const doc = useEditorStore((s) => s.doc);
  useEditorStore((s) => s.saveState);
  useEditorStore((s) => s.savedAt);
  useEditorStore((s) => s.canUndo);
  useEditorStore((s) => s.canRedo);
  useEditorStore((s) => s.docs);
  useEditorStore((s) => s.currentDocId);
  useEditorStore((s) => s.searchQuery);
  useEditorStore((s) => s.searchResults);
  useEditorStore((s) => s.layoutUi.scopeSelected);
  const viewport = useEditorStore((s) => s.viewport);
  // 一键整理 ghost 预览期间显示「应用 / 取消」浮动条。
  const layoutPreview = useEditorStore((s) => s.layoutPreview);

  // 面板开关（纯 UI 态）
  useWiringUi((s) => s.exportOpen);
  useWiringUi((s) => s.searchOpen);
  useWiringUi((s) => s.activeSearchIndex);

  // 导出数据流
  const { result, sheetsVisible, actions } = useExportModel(panelsApi);

  // DEV-only：e2e 常驻打印容器（window.__drawpaper_debugSheets）。生产构建 import.meta.env.DEV=false 被剔除。
  const debugSheetsOn = import.meta.env.DEV && typeof window !== 'undefined' && !!window.__drawpaper_debugSheets;
  const debugResult = useMemo(
    () => (debugSheetsOn ? computePanelsPaginate(panelsApi) : null),
    // doc 变化重算分页（刻意依赖）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debugSheetsOn, panelsApi, doc],
  );

  // 画布分页虚线叠加层：开启 showPageBreak 时实时算分页结果。
  const overlayResult = useMemo(
    () => (doc.page.showPageBreak ? computePanelsPaginate(panelsApi) : null),
    // doc 引用每次写操作都变，足够驱动 overlay 重算。
    [doc, panelsApi],
  );

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* 画布（React Flow + Tiptap 块 + 连线 + 快捷键 + 冲突弹窗） */}
      <div className="absolute inset-0">
        <CanvasEditor api={editorApi} />
      </div>

      {/* 画布分页虚线叠加层（世界坐标 → 屏幕坐标由 viewport 折算） */}
      {overlayResult && overlayResult.pages.length > 0 && (
        <div className="pointer-events-none absolute inset-0 z-[5]">
          <PageBreakOverlay
            result={overlayResult}
            viewport={viewport}
            onDragOrigin={(o) => panelsApi.setPageOrigin(o)}
          />
        </div>
      )}

      {/* 面板层 */}
      <TopToolbar api={panelsApi} />
      <DocsListPanel api={panelsApi} />
      <SearchPanel api={panelsApi} />

      {/* 导出弹窗 + 离屏打印容器 */}
      <ExportDialog api={panelsApi} actions={actions} />
      {sheetsVisible && result.pages.length > 0 && (
        <PrintSheets result={result} doc={doc} settings={doc.page} edgeLabelsVisible={doc.page.edgeLabels} />
      )}
      {debugSheetsOn && debugResult && debugResult.pages.length > 0 && (
        <PrintSheets result={debugResult} doc={doc} settings={doc.page} edgeLabelsVisible={doc.page.edgeLabels} />
      )}

      {/* 一键整理 ghost 预览：应用 / 取消 */}
      {layoutPreview ? (
        <div className="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-slate-800/90 px-4 py-2 text-white shadow-lg">
          <span className="text-xs opacity-80">整理预览</span>
          <button
            className="rounded-full bg-emerald-500 px-3 py-1 text-xs font-medium hover:bg-emerald-400"
            onClick={() => editorApi.confirmLayout()}
          >
            应用
          </button>
          <button
            className="rounded-full bg-slate-600 px-3 py-1 text-xs hover:bg-slate-500"
            onClick={() => editorApi.cancelLayout()}
          >
            取消
          </button>
        </div>
      ) : null}

      {/* 全局 toast（editor 与 panels 共用） */}
      <Toaster />
    </div>
  );
}
