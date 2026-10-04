import * as React from 'react';
import {
  FilePlus2,
  FolderOpen,
  Save,
  Undo2,
  Redo2,
  ArrowRightFromLine,
  ArrowDownFromLine,
  Network,
  SlidersHorizontal,
  Search,
  FileDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toolbar, ToolbarSeparator } from '@/components/ui/toolbar';
import { Toggle } from '@/components/ui/toggle';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { PanelsApi } from './panels-api';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 文档标题行内重命名。 */
function TitleRename({ api }: { api: PanelsApi }) {
  const title = api.doc?.title ?? '';
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(title);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (editing) {
      setValue(title);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, title]);

  const commit = () => {
    const t = value.trim();
    if (t && api.currentDocId) api.renameDoc(api.currentDocId, t);
    setEditing(false);
  };

  if (!api.currentDocId) return null;
  if (!editing) {
    return (
      <button
        type="button"
        className="max-w-[200px] truncate rounded px-1 text-sm font-semibold hover:bg-accent"
        title="重命名文档"
        onDoubleClick={() => setEditing(true)}
      >
        {title || '未命名'}
      </button>
    );
  }
  return (
    <Input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setEditing(false);
      }}
      className="h-7 w-40 text-sm"
    />
  );
}

function SaveStatus({ api }: { api: PanelsApi }) {
  if (api.saveState === 'saving') {
    return <span className="text-xs text-muted-foreground">保存中…</span>;
  }
  if (api.saveState === 'saved' && api.savedAt) {
    return (
      <span className="text-xs text-muted-foreground">已自动保存 {formatTime(api.savedAt)}</span>
    );
  }
  return null;
}

/**
 * 顶部工具栏：文档标题 / 保存状态 / 文档操作 / 撤销重做 / 布局 / 间距 / 导出 / 搜索。
 * 布局按钮只切模式并触发预览确认流（确认 UI 在画布侧）。
 */
export const TopToolbar = React.memo(function TopToolbar({ api }: { api: PanelsApi }) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const { layoutPrefs } = api;

  const pickLayout = (mode: PanelsApi['layoutPrefs']['mode']) => {
    api.setLayoutMode(mode);
    api.previewLayout();
  };

  return (
    <header className="absolute left-0 right-0 top-0 z-20 flex h-12 items-center gap-2 border-b bg-white/85 px-3 backdrop-blur">
      <span className="text-sm font-bold tracking-tight">drawpaper</span>
      <Separator orientation="vertical" className="!h-5" />

      <TitleRename api={api} />
      <SaveStatus api={api} />

      {/* 文档操作菜单 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            文档
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>文档</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => api.newDoc()}>
            <FilePlus2 /> 新建文档
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
            <FolderOpen /> 导入 .kbnote
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => api.currentDocId && api.exportKbnote(api.currentDocId)}>
            <Save /> 导出 .kbnote
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => api.requestSave()}>
            <FileDown /> 立即保存
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileInputRef}
        type="file"
        accept=".kbnote,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) api.importKbnote(f);
          e.target.value = '';
        }}
      />

      <ToolbarSeparator />

      {/* 撤销 / 重做 */}
      <Toolbar>
        <Button variant="ghost" size="icon" disabled={!api.canUndo} onClick={() => api.undo()} title="撤销 (Ctrl+Z)">
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" disabled={!api.canRedo} onClick={() => api.redo()} title="重做 (Ctrl+Y)">
          <Redo2 className="h-4 w-4" />
        </Button>
      </Toolbar>

      <ToolbarSeparator />

      {/* 布局三模式 */}
      <Toolbar>
        <Toggle
          size="sm"
          pressed={layoutPrefs.mode === 'mindmap-right'}
          onPressedChange={() => pickLayout('mindmap-right')}
          title="思维导图 · 横向"
        >
          <ArrowRightFromLine className="h-4 w-4" /> 横向
        </Toggle>
        <Toggle
          size="sm"
          pressed={layoutPrefs.mode === 'mindmap-down'}
          onPressedChange={() => pickLayout('mindmap-down')}
          title="思维导图 · 纵向"
        >
          <ArrowDownFromLine className="h-4 w-4" /> 纵向
        </Toggle>
        <Toggle
          size="sm"
          pressed={layoutPrefs.mode === 'org-tree'}
          onPressedChange={() => pickLayout('org-tree')}
          title="组织结构树"
        >
          <Network className="h-4 w-4" /> 组织树
        </Toggle>
      </Toolbar>

      {/* 间距弹层 */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" title="布局间距">
            <SlidersHorizontal className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64">
          <div className="grid gap-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>层级间距</Label>
                <span className="text-xs text-muted-foreground">{layoutPrefs.rankSpacing}px</span>
              </div>
              <Slider
                min={40}
                max={200}
                step={5}
                value={[layoutPrefs.rankSpacing]}
                onValueChange={([v]) => v !== undefined && api.setRankSpacing(v)}
              />
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>同级间距</Label>
                <span className="text-xs text-muted-foreground">{layoutPrefs.nodeSpacing}px</span>
              </div>
              <Slider
                min={10}
                max={80}
                step={2}
                value={[layoutPrefs.nodeSpacing]}
                onValueChange={([v]) => v !== undefined && api.setNodeSpacing(v)}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="branch-only">仅整理选中分支</Label>
              <Switch
                id="branch-only"
                checked={api.branchOnly}
                onCheckedChange={(v) => api.setBranchOnly(v)}
              />
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => api.openSearch()} title="全文搜索 (Ctrl/Cmd+F)">
          <Search className="h-4 w-4" /> 搜索
        </Button>
        <Button size="sm" onClick={() => api.openExport()}>
          <FileDown className="h-4 w-4" /> 导出
        </Button>
        {api.page.showPageBreak ? (
          <Badge variant="warning">分页预览中</Badge>
        ) : null}
      </div>
    </header>
  );
});
