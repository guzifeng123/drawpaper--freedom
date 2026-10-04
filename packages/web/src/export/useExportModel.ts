import * as React from 'react';
import {
  layoutTree,
  paginateFit,
  paginateTiles,
  paginateFlow,
  type LayoutResult,
  type PaginateResult,
  type MeasuredSize,
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

/**
 * 胶水 hook：从 api 取 doc / page 设置，调 core 的 layoutTree + paginate*。
 *
 * 注意：本分支 core 的 layout/paginate 仍是 throw('not implemented') 占位。
 * 这里保持薄封装 + try/catch：不可用时返回空分页结果，导出按钮不崩，
 * 真实分页由 Wave1-B 实现后、Wave2 e2e 联调。**不对本 hook 写单测。**
 */
export function useExportModel(api: PanelsApi): {
  result: PaginateResult | null;
  sheetsVisible: boolean;
  actions: ExportDialogActions;
} {
  const [result, setResult] = React.useState<PaginateResult | null>(null);
  const [sheetsVisible, setSheetsVisible] = React.useState(false);

  const computeResult = React.useCallback((): PaginateResult => {
    const doc = api.doc;
    if (!doc) return { pages: [], orphans: [], totalPages: 0 };
    try {
      const measured: Record<string, MeasuredSize> = {};
      for (const n of doc.nodes) measured[n.id] = { width: n.width, height: n.height };
      const layout: LayoutResult = layoutTree(
        {
          nodes: doc.nodes,
          edges: doc.edges,
          rankSpacing: doc.layout.rankSpacing,
          nodeSpacing: doc.layout.nodeSpacing,
          measured,
        },
        doc.layout.mode,
      );
      const fn =
        doc.page.mode === 'fit' ? paginateFit : doc.page.mode === 'flow' ? paginateFlow : paginateTiles;
      const r = fn({ layout, measured, settings: doc.page });
      return r;
    } catch {
      // core 尚未实现：返回空分页，UI 不崩。
      return { pages: [], orphans: [], totalPages: 0 };
    }
  }, [api]);

  const afterSheetsRender = React.useCallback(
    async (job: () => Promise<void>) => {
      setSheetsVisible(true);
      // 等 React 把 <PrintSheets/> 提交到 DOM 后再取 sheet 元素。
      await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 60)));
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
