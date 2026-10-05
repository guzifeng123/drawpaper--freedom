import { useMemo, useEffect } from 'react';
import { editorStore, conflictBridge, hostAdapter } from '@/store/editor-store';
import { useEditorStore } from '@/store';
import { createEditorApi } from '@/wiring/create-editor-api';
import { createPanelsApi } from '@/wiring/create-panels-api';
import { createAiApi } from '@/wiring/create-ai-api';
import { createBackupScheduler } from '@/wiring/backup-scheduler';
import { pushToast } from '@/panels/lib/toast';
import { useWiringUi } from '@/wiring/ui-store';
import { CanvasEditor } from '@/editor/canvas/CanvasEditor';
import { TopToolbar } from '@/panels/TopToolbar';
import { DocsListPanel } from '@/panels/DocsListPanel';
import { SearchPanel } from '@/panels/SearchPanel';
import { OutlinePanel } from '@/panels/OutlinePanel';
import { TagFilterBar } from '@/panels/TagFilterBar';
import { BacklinksPanel } from '@/panels/BacklinksPanel';
import { Toaster } from '@/panels/lib/toast';
import { AiPanel } from '@/ai/AiPanel';
import { setDocRefClickHandler, installDocRefClickDelegate } from '@/editor/tiptap/doc-ref-mark';
import { OverviewCanvas } from '@/overview/OverviewCanvas';
import { DexieOverviewProvider } from '@/overview/DexieOverviewProvider';
import {
  ExportDialog,
  PageBreakOverlay,
  PrintSheets,
  useExportModel,
  computePanelsPaginate,
} from '@/export';

/**
 * App 总装（Wave4 P1）：在 Wave2 基础上接齐大纲 / 标签筛选 / AI 面板 / 导出新选项。
 *
 * - CanvasEditor 拿真实 EditorApi（含 focusNodeId/tagFilter/manualFixed/reverseEdge）；
 * - TopToolbar / DocsListPanel / SearchPanel / OutlinePanel / TagFilterBar 拿 PanelsApi；
 * - AiPanel 接真实 createAiApi（合入 → previewLayout）；
 * - 导出三按钮 + SVG / Markdown 端到端打通。
 */
export default function App() {
  // editorApi 必须稳定（useSyncExternalStore 要求 subscribe 引用不变）；
  // panelsApi 每次渲染重建——其 getters 读最新 store，新引用驱动 memo 面板重渲染。
  const editorApi = useMemo(() => createEditorApi(editorStore, conflictBridge), []);
  const aiApi = useMemo(() => createAiApi(editorStore), []);
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
  useEditorStore((s) => s.focusNodeId);
  useEditorStore((s) => s.tagFilter);
  useEditorStore((s) => s.activeFile);
  useEditorStore((s) => s.manuallyMoved);
  const viewport = useEditorStore((s) => s.viewport);
  // 一键整理 ghost 预览期间显示「应用 / 取消」浮动条。
  const layoutPreview = useEditorStore((s) => s.layoutPreview);

  // 面板开关（纯 UI 态）
  useWiringUi((s) => s.exportOpen);
  useWiringUi((s) => s.searchOpen);
  useWiringUi((s) => s.activeSearchIndex);
  const aiPanelOpen = useWiringUi((s) => s.aiPanelOpen);
  const outlineOpen = useWiringUi((s) => s.outlineOpen);
  const backlinksOpen = useWiringUi((s) => s.backlinksOpen);
  const overviewOpen = useWiringUi((s) => s.overviewOpen);
  useWiringUi((s) => s.snapshotsNonce);
  useWiringUi((s) => s.trashNonce);

  // 全局图谱总览 provider（只读 Dexie；引用稳定）。
  const overviewProvider = useMemo(() => new DexieOverviewProvider(), []);

  // 跨文档双链：docRef chip 点击 → 真实 store openDocRef（跨文档 openDoc+flyTo+高亮）。
  useEffect(() => {
    setDocRefClickHandler((attrs) => {
      const targetDocId = attrs.targetDocId;
      const targetNodeId = attrs.targetNodeId ?? '';
      const s = editorStore.getState();
      if (targetDocId === s.currentDocId) {
        s.flyToNode(targetNodeId);
      } else {
        void s.openDoc(targetDocId).then(() => {
          editorStore.getState().flyToNode(targetNodeId);
        });
      }
    });
    const dispose = installDocRefClickDelegate();
    return () => {
      setDocRefClickHandler(null);
      dispose();
    };
  }, []);

  // 导出数据流
  const { result, sheetsVisible, actions, scope, setScope, busy } = useExportModel(panelsApi);

  // 定时备份调度：backupEnabled 开启且 dirty 时每 10 分钟下载一份 .kbnote 备份。
  const backupEnabled = useEditorStore((s) => s.backupEnabled);
  useEffect(() => {
    if (!backupEnabled) return;
    const sched = createBackupScheduler({
      isEnabled: () => editorStore.getState().backupEnabled,
      isDirty: () => editorStore.getState().dirty,
      runBackup: () => {
        const s = editorStore.getState();
        const stamp = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        const name = `${s.doc.title || '未命名画布'}_备份_${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}-${p(stamp.getHours())}${p(stamp.getMinutes())}`;
        void hostAdapter.showSaveFilePicker(name, s.exportKBNoteText());
      },
      onBackupDone: () => {
        editorStore.getState().requestSave();
        pushToast('success', '已创建定时备份');
      },
    });
    sched.start();
    return () => sched.stop();
  }, [backupEnabled]);

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
            breaks={(panelsApi.doc?.page.pageBreaks ?? []) as unknown as { id: string; x: number; y: number }[]}
            onMoveBreak={(id, x, y) => {
              const cur = (panelsApi.doc?.page.pageBreaks ?? []) as unknown as { id: string; x: number; y: number }[];
              editorApi.setPageBreaks(cur.map((b) => (b.id === id ? { ...b, x, y } : b)));
            }}
            onDeleteBreak={(id) => editorApi.removePageBreak(id)}
          />
        </div>
      )}

      {/* 面板层 */}
      <TopToolbar api={panelsApi} />
      <DocsListPanel api={panelsApi} />
      <SearchPanel api={panelsApi} />
      {/* 大纲（左侧可折叠，默认收起避免遮挡建块区域）+ 标签筛选条 */}
      {outlineOpen ? <OutlinePanel api={panelsApi} /> : null}
      <TagFilterBar api={panelsApi} />
      {/* 反链面板（右侧可折叠，文档级/块级联动 editingNodeId） */}
      {backlinksOpen ? (
        <div className="absolute right-4 top-14 z-20 flex h-[70vh] w-72 flex-col rounded-lg border bg-card/95 shadow-lg">
          <div className="flex justify-end px-1 pt-1">
            <button
              type="button"
              aria-label="关闭反链面板"
              className="rounded p-1 text-muted-foreground hover:bg-accent"
              onClick={() => useWiringUi.getState().setBacklinksOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <BacklinksPanel api={panelsApi} />
          </div>
        </div>
      ) : null}
      {/* AI 辅助面板（右侧可开关） */}
      {aiPanelOpen ? (
        <div className="absolute bottom-4 right-4 z-20 w-72 rounded-lg border bg-card/95 p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-end">
            <button
              type="button"
              aria-label="关闭 AI 面板"
              className="rounded p-1 text-muted-foreground hover:bg-accent"
              onClick={() => useWiringUi.getState().setAiPanelOpen(false)}
            >
              ×
            </button>
          </div>
          <AiPanel doc={doc} api={aiApi} />
        </div>
      ) : null}

      {/* 导出弹窗 + 离屏打印容器 */}
      <ExportDialog api={panelsApi} actions={actions} scope={scope} onScopeChange={setScope} busy={busy} />
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

      {/* 全局知识图谱总览（全屏只读，点块跳回文档） */}
      {overviewOpen ? (
        <div className="fixed inset-0 z-40 bg-background">
          <OverviewCanvas
            provider={overviewProvider}
            onClose={() => useWiringUi.getState().setOverviewOpen(false)}
            onOpenDocNode={(docId, nodeId) => {
              useWiringUi.getState().setOverviewOpen(false);
              const s = editorStore.getState();
              if (docId === s.currentDocId) {
                s.flyToNode(nodeId);
              } else {
                void s.openDoc(docId).then(() => editorStore.getState().flyToNode(nodeId));
              }
            }}
          />
        </div>
      ) : null}

      {/* 全局 toast（editor 与 panels 共用） */}
      <Toaster />
    </div>
  );
}
