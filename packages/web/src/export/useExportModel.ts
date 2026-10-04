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
import type { ExportDialogActions } from './ExportDialog';
import {
  collectSheetElements,
  downloadSheetsAsPdf,
  downloadSheetsAsPng,
  runVectorPrint,
} from './print-pipeline';
import { buildExportFileName } from './filename';

const EMPTY_RESULT: PaginateResult = { pages: [], orphans: [], totalPages: 0, notes: [] };

/**
 * 独立可复用的分页计算（所见即所得三模式）。导出按钮与画布分页虚线叠加层共用同一逻辑。
 */
export function computePanelsPaginate(api: PanelsApi): PaginateResult {
  const doc = api.doc;
  if (!doc) return EMPTY_RESULT;
  try {
    const measured: Record<string, MeasuredSize> = {};
    for (const n of doc.nodes) measured[n.id] = { width: n.width, height: n.height };
    const settings: PaginateSettings = {
      ...doc.page,
      grayScale: doc.page.colorMode === 'gray',
      showEdgeLabels: doc.page.edgeLabels,
    };

    if (doc.page.mode === 'flow') {
      const layout = layoutTree(
        {
          nodes: doc.nodes,
          edges: doc.edges,
          rankSpacing: doc.layout.rankSpacing,
          nodeSpacing: doc.layout.nodeSpacing,
          measured,
        },
        'mindmap-down',
      );
      const collapsed: Record<string, boolean> = {};
      for (const n of doc.nodes) if (n.collapsed) collapsed[n.id] = true;
      return paginateFlow({ layout, measured, settings, nodes: doc.nodes, edges: doc.edges, collapsed });
    }

    const positions: LayoutResult['positions'] = {};
    for (const n of doc.nodes) positions[n.id] = { x: n.x, y: n.y };
    const layout: LayoutResult = {
      positions,
      collisions: { overlappingPairs: [], detouredNodes: [] },
      notes: [],
    };
    // 折叠子树：从节点的 collapsed 标志推导 map 传入分页（否则折叠后代会被导出）。
    const collapsed: Record<string, boolean> = {};
    for (const n of doc.nodes) if (n.collapsed) collapsed[n.id] = true;
    const fn = doc.page.mode === 'fit' ? paginateFit : paginateTiles;
    return fn({ layout, measured, settings, nodes: doc.nodes, edges: doc.edges, collapsed });
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
} {
  const [result, setResult] = React.useState<PaginateResult>(EMPTY_RESULT);
  const [sheetsVisible, setSheetsVisible] = React.useState(false);

  const computeResult = React.useCallback((): PaginateResult => computePanelsPaginate(api), [api]);

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
          const sheets = collectSheetElements();
          const name = buildExportFileName({
            title: api.doc?.title ?? '未命名',
            date: new Date(),
            orientation: api.page.orientation,
            ext: 'png',
          });
          await downloadSheetsAsPng(sheets, name);
        });
      },
      onExportPdf: () => {
        setResult(computeResult());
        void afterSheetsRender(async () => {
          const sheets = collectSheetElements();
          const name = buildExportFileName({
            title: api.doc?.title ?? '未命名',
            date: new Date(),
            orientation: api.page.orientation,
            ext: 'pdf',
          });
          await downloadSheetsAsPdf(sheets, name, api.page.orientation);
        });
      },
    }),
    [api, afterSheetsRender, computeResult],
  );

  return { result, sheetsVisible, actions };
}
