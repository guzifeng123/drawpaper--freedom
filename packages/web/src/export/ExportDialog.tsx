import * as React from 'react';
import { Printer, ImageDown, FileDown, FileCode, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import type { PageMode, PageOrientation } from '@drawpaper/core';
import type { PanelsApi } from '@/panels/panels-api';
import { buildExportFileName } from './filename';

export type ExportScope = 'all' | 'selected' | 'bbox';

export interface ExportDialogActions {
  /** [打印 / 另存 PDF] 矢量主线：走 window.print()。 */
  onPrint: () => void;
  /** 导出高清 PNG（逐页）。 */
  onExportPng: () => void;
  /** 直接下载 PDF（pdf-lib 位图合成）。 */
  onExportPdf: () => void;
  /** 导出矢量 SVG（每页一个 .svg）。 */
  onExportSvg: () => void;
  /** 导出 Markdown 大纲（.md）。 */
  onExportMarkdown: () => void;
}

const MODE_DESC: Record<PageMode, string> = {
  fit: '等比缩放铺满单页，导图总览一页带走。',
  tiles: '保留空间布局，按 A4 网格切页，跨页连线成对续接。',
  flow: '树按深度转纵向打印流，块绝不跨页截断，讲义可读性最佳。',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Label className="text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * 导出选项弹窗。
 * 选项用本地 state 镜像 api.page（打开时初始化），切换时同时写回 api.setPageSettings。
 * 操作按钮回调由胶水注入。
 */
export function ExportDialog({
  api,
  actions,
  scope,
  onScopeChange,
}: {
  api: PanelsApi;
  actions: ExportDialogActions;
  scope: ExportScope;
  onScopeChange: (s: ExportScope) => void;
}) {
  const src = api.page;
  const [orientation, setOrientationState] = React.useState<PageOrientation>(src.orientation);
  const [mode, setModeState] = React.useState<PageMode>(src.mode);
  const [marginMm, setMarginState] = React.useState(src.marginMm);
  const [header, setHeaderState] = React.useState(src.header);
  const [footer, setFooterState] = React.useState(src.footer);
  const [showPageNumbers, setPageNumbersState] = React.useState(src.showPageNumbers);
  const [colorMode, setColorModeState] = React.useState(src.colorMode);
  const [edgeLabels, setEdgeLabelsState] = React.useState(src.edgeLabels);

  const fileName = buildExportFileName({
    title: api.doc?.title ?? '未命名',
    date: new Date(),
    orientation,
    ext: 'pdf',
  });

  const setOrientation = (o: PageOrientation) => {
    setOrientationState(o);
    api.setPageSettings({ orientation: o });
  };
  const setMode = (m: PageMode) => {
    setModeState(m);
    api.setPageSettings({ mode: m });
  };

  return (
    <Dialog open={api.exportOpen} onOpenChange={(o) => !o && api.closeExport()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>导出 / 打印</DialogTitle>
          <DialogDescription>把当前画布排版为 A4 PDF / PNG。</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {/* 方向：radio 卡片 */}
          <div className="grid grid-cols-2 gap-2">
            {(['portrait', 'landscape'] as const).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => setOrientation(o)}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-md border-2 p-3 text-sm transition-colors',
                  orientation === o
                    ? 'border-primary bg-accent'
                    : 'border-input hover:bg-accent/50',
                )}
              >
                <span
                  className={cn(
                    'border border-current',
                    o === 'portrait' ? 'h-8 w-6' : 'h-6 w-8',
                  )}
                />
                {o === 'portrait' ? 'A4 纵向' : 'A4 横向'}
              </button>
            ))}
          </div>

          {/* 排版模式 tabs */}
          <div>
            <Tabs value={mode} onValueChange={(v) => setMode(v as PageMode)}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="fit">Fit 一页</TabsTrigger>
                <TabsTrigger value="tiles">Tiles 分页</TabsTrigger>
                <TabsTrigger value="flow">Flow 重排</TabsTrigger>
              </TabsList>
            </Tabs>
            <p className="mt-1.5 text-xs text-muted-foreground">{MODE_DESC[mode]}</p>
          </div>

          <Separator />

          <Row label="页边距">
            {([10, 15, 20] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={marginMm === m ? 'default' : 'outline'}
                onClick={() => {
                  setMarginState(m);
                  api.setPageSettings({ marginMm: m });
                }}
              >
                {m}mm
              </Button>
            ))}
          </Row>

          <Row label="页眉（文档标题）">
            <Switch
              checked={header}
              onCheckedChange={(v) => {
                setHeaderState(v);
                api.setPageSettings({ header: v });
              }}
            />
          </Row>
          <Row label="页脚">
            <Switch
              checked={footer}
              onCheckedChange={(v) => {
                setFooterState(v);
                api.setPageSettings({ footer: v });
              }}
            />
          </Row>
          <Row label="页码">
            <Switch
              checked={showPageNumbers}
              onCheckedChange={(v) => {
                setPageNumbersState(v);
                api.setPageSettings({ showPageNumbers: v });
              }}
            />
          </Row>
          <Row label="边（连线）标签">
            <Switch
              checked={edgeLabels}
              onCheckedChange={(v) => {
                setEdgeLabelsState(v);
                api.setPageSettings({ edgeLabels: v });
              }}
            />
          </Row>
          <Row label="彩色 / 黑白">
            <Switch
              checked={colorMode === 'color'}
              onCheckedChange={(v) => {
                const c = v ? 'color' : 'gray';
                setColorModeState(c);
                api.setPageSettings({ colorMode: c });
              }}
            />
            <span className="text-xs text-muted-foreground">
              {colorMode === 'color' ? '彩色' : '黑白'}
            </span>
          </Row>
          <Row label="范围">
            <Button
              size="sm"
              variant={scope === 'all' ? 'default' : 'outline'}
              onClick={() => onScopeChange('all')}
            >
              全部
            </Button>
            <Button
              size="sm"
              variant={scope === 'selected' ? 'default' : 'outline'}
              onClick={() => onScopeChange('selected')}
            >
              仅选中分支
            </Button>
            <Button
              size="sm"
              variant={scope === 'bbox' ? 'default' : 'outline'}
              disabled={(api.selectedNodeIds ?? []).length === 0}
              title={(api.selectedNodeIds ?? []).length === 0 ? '先在画布框选若干块' : '仅导出选中节点包围盒内的内容'}
              onClick={() => onScopeChange('bbox')}
            >
              仅选中区域
            </Button>
          </Row>
          <Row label="显示分页预览">
            <Switch
              checked={src.showPageBreak}
              onCheckedChange={(v) => api.setPageSettings({ showPageBreak: v })}
            />
          </Row>

          <Separator />

          <div className="text-xs text-muted-foreground">
            文件名：<span className="font-mono text-foreground">{fileName}</span>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <div className="flex flex-wrap gap-2">
            <Button onClick={actions.onPrint}>
              <Printer className="h-4 w-4" /> 打印 / 另存 PDF
            </Button>
            <Button variant="outline" onClick={actions.onExportPng}>
              <ImageDown className="h-4 w-4" /> 导出高清 PNG
            </Button>
            <Button variant="outline" onClick={actions.onExportPdf}>
              <FileDown className="h-4 w-4" /> 直接下载 PDF
            </Button>
            <Button variant="outline" onClick={actions.onExportSvg}>
              <FileCode className="h-4 w-4" /> 矢量 SVG
            </Button>
            <Button variant="outline" onClick={actions.onExportMarkdown}>
              <FileText className="h-4 w-4" /> Markdown
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
