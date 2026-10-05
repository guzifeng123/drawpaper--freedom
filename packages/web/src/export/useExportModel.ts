import * as React from 'react';
import {
  layoutTree,
  paginateFit,
  paginateTiles,
  paginateFlow,
  type LayoutResult,
  type PaginateResult,
  type MeasuredSize,
  type PaginateSettings,
} from '@drawpaper/core';
import type { PanelsApi } from '@/panels/panels-api';
import { type ExportDialogActions, type ExportScope } from './ExportDialog';
import {
  collectSheetElements,
  downloadSheetsAsPdf,
  downloadSheetsAsPng,
  runVectorPrint,
} from './print-pipeline';
import { buildPagesSvgAsync, downloadSvgPages } from './svg-export';
import { docToMarkdown, downloadTextFile } from './markdown-export';
import { buildExportFileName } from './filename';
import { pushToast } from '@/panels/lib/toast';

const EMPTY_RESULT: PaginateResult = { pages: [], orphans: [], totalPages: 0, notes: [] };

/**
 * 独立可复用的分页计算（所见即所得三模式）。导出按钮与画布分页虚线叠加层共用同一逻辑。
 */
export function computePanelsPaginate(api: PanelsApi, scope: 'all' | 'selected' | 'bbox' = 'all'): PaginateResult {
  const doc = api.doc;
  if (!doc) return EMPTY_RESULT;
  try {
    // bbox 范围：仅保留与当前选中节点包围盒相交的节点（含其连接边）。
    let nodes = doc.nodes;
    let edges = doc.edges;
    if (scope === 'bbox') {
      const sel = new Set(api.selectedNodeIds ?? []);
      if (sel.size > 0) {
        const box = {
          minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
        };
        for (const n of doc.nodes) {
          if (!sel.has(n.id)) continue;
          box.minX = Math.min(box.minX, n.x);
          box.minY = Math.min(box.minY, n.y);
          box.maxX = Math.max(box.maxX, n.x + n.width);
          box.maxY = Math.max(box.maxY, n.y + n.height);
        }
        nodes = doc.nodes.filter((n) =>
          n.x < box.maxX && n.x + n.width > box.minX && n.y < box.maxY && n.y + n.height > box.minY);
        const ids = new Set(nodes.map((n) => n.id));
        edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
      }
    }
    const measured: Record<string, MeasuredSize> = {};
    for (const n of nodes) measured[n.id] = { width: n.width, height: n.height };
    const settings: PaginateSettings = {
      ...doc.page,
      grayScale: doc.page.colorMode === 'gray',
      showEdgeLabels: doc.page.edgeLabels,
    };

    if (doc.page.mode === 'flow') {
      const layout = layoutTree(
        {
          nodes,
          edges,
          rankSpacing: doc.layout.rankSpacing,
          nodeSpacing: doc.layout.nodeSpacing,
          measured,
        },
        'mindmap-down',
      );
      const collapsed: Record<string, boolean> = {};
      for (const n of nodes) if (n.collapsed) collapsed[n.id] = true;
      return paginateFlow({ layout, measured, settings, nodes, edges, collapsed });
    }

    const positions: LayoutResult['positions'] = {};
    for (const n of nodes) positions[n.id] = { x: n.x, y: n.y };
    const layout: LayoutResult = {
      positions,
      collisions: { overlappingPairs: [], detouredNodes: [] },
      notes: [],
    };
    const collapsed: Record<string, boolean> = {};
    for (const n of nodes) if (n.collapsed) collapsed[n.id] = true;
    const fn = doc.page.mode === 'fit' ? paginateFit : paginateTiles;
    return fn({ layout, measured, settings, nodes, edges, collapsed });
  } catch {
    return EMPTY_RESULT;
  }
}

/**
 * 胶水 hook：从 api 取 doc / page 设置，调 core 的 layoutTree + paginate*（Wave2 接真实数据流）。
 *
 * 三模式输入：
 *  - fit / tiles：以当前画布节点坐标（所见即所得）作为 layout 结果输入分页；
 *  - flow：先用 core.layoutTree（mindmap-down）重排，再交 paginateFlow 切纵向打印流。
 *
 * 三条输出按钮（打印 / PNG / PDF）在 afterSheetsRender 内等 <PrintSheets/> 入 DOM 后执行。
 */
export function useExportModel(api: PanelsApi): {
  result: PaginateResult;
  sheetsVisible: boolean;
  actions: ExportDialogActions;
  scope: ExportScope;
  setScope: (s: ExportScope) => void;
  busy: 'png' | 'pdf' | null;
} {
  const [result, setResult] = React.useState<PaginateResult>(EMPTY_RESULT);
  const [sheetsVisible, setSheetsVisible] = React.useState(false);
  const [scope, setScope] = React.useState<ExportScope>('all');
  const [busy, setBusy] = React.useState<'png' | 'pdf' | null>(null);

  const computeResult = React.useCallback((): PaginateResult => computePanelsPaginate(api, scope), [api, scope]);

  const afterSheetsRender = React.useCallback(
    async (job: () => Promise<void>) => {
      setSheetsVisible(true);
      // 等 React 把 <PrintSheets/> 提交到 DOM 后再取 sheet 元素。
      await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 80)));
      try {
        await job();
      } finally {
        setSheetsVisible(false);
      }
    },
    [],
  );

  const actions = React.useMemo<ExportDialogActions>(
    () => ({
      onPrint: () => {
        setResult(computeResult());
        void afterSheetsRender(async () => {
          await runVectorPrint(api.page.orientation);
        });
      },
      onExportPng: () => {
        setResult(computeResult());
        void afterSheetsRender(async () => {
          setBusy('png');
          try {
            const sheets = collectSheetElements();
            const name = buildExportFileName({
              title: api.doc?.title ?? '未命名',
              date: new Date(),
              orientation: api.page.orientation,
              ext: 'png',
            });
            await downloadSheetsAsPng(sheets, name);
          } catch (err) {
            console.error(err);
            pushToast('error', 'PNG 导出失败（图形库加载或渲染出错）');
          } finally {
            setBusy(null);
          }
        });
      },
      onExportPdf: () => {
        setResult(computeResult());
        void afterSheetsRender(async () => {
          setBusy('pdf');
          try {
            const sheets = collectSheetElements();
            const name = buildExportFileName({
              title: api.doc?.title ?? '未命名',
              date: new Date(),
              orientation: api.page.orientation,
              ext: 'pdf',
            });
            await downloadSheetsAsPdf(sheets, name, api.page.orientation);
          } catch (err) {
            console.error(err);
            pushToast('error', 'PDF 合成失败（pdf-lib 加载或渲染出错）');
          } finally {
            setBusy(null);
          }
        });
      },
      onExportSvg: () => {
        if (!api.doc) return;
        const r = computeResult();
        if (r.pages.length === 0) return;
        // 异步：先把 OPFS 图片读成 data: URI 内嵌进 SVG（离线可见）。
        void (async () => {
          try {
            const svgs = await buildPagesSvgAsync(r, api.doc!, {
              orientation: api.page.orientation,
              gray: api.page.colorMode === 'gray',
            });
            const name = buildExportFileName({
              title: api.doc!.title ?? '未命名',
              date: new Date(),
              orientation: api.page.orientation,
              ext: 'svg',
            });
            downloadSvgPages(svgs, name);
          } catch (err) {
            console.error(err);
            pushToast('error', 'SVG 导出失败');
          }
        })();
      },
      onExportMarkdown: () => {
        if (!api.doc) return;
        const md = docToMarkdown(api.doc);
        const name = buildExportFileName({
          title: api.doc.title ?? '未命名',
          date: new Date(),
          orientation: api.page.orientation,
          ext: 'md',
        });
        downloadTextFile(name, md);
      },
    }),
    [api, afterSheetsRender, computeResult],
  );

  return { result, sheetsVisible, actions, scope, setScope, busy };
}
