import { memo, useEffect, useRef, useState } from 'react';
import { ExternalLink, FileText, Trash2, Upload, CalendarClock } from 'lucide-react';
import { useEditorApi } from '../canvas/editor-context';
import { StaticHtml } from '../tiptap/static';
import { renderEquationAsync } from '../tiptap/katex-html';
import { CODE_LANGUAGES, codeToHtmlAsync, extractCodeText } from '../tiptap/highlight';
import { setCodeLanguage, readCodeLanguage } from '../tiptap/code-ops';
import {
  type EquationData,
  type BookmarkData,
  type AttachmentData,
  type ReminderData,
} from '../content-defaults';
import { BlockShell } from './BlockShell';
import type { AppNode } from './types';

/** 读 P1 payload；缺省给空对象。 */
function p1d<T>(block: { content: { data: unknown } }): T {
  return (block.content.data as T) ?? ({} as T);
}

function formatSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 公式块静态 HTML：懒加载 katex，加载中显示占位，加载完替换（不阻塞虚拟化）。 */
const EquationHtml = memo(function EquationHtml({ source }: { source: string }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let alive = true;
    void renderEquationAsync(source).then((h) => {
      if (alive) setHtml(h);
    });
    return () => {
      alive = false;
    };
  }, [source]);
  if (!html) return <div className="py-3 text-center text-xs text-slate-400">公式渲染中…</div>;
  return <div className="equation-html w-full py-1 text-center" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** 代码块静态高亮 HTML：懒加载 hljs，加载中显示占位。 */
const CodeHtml = memo(function CodeHtml({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let alive = true;
    void codeToHtmlAsync(code, lang).then((h) => {
      if (alive) setHtml(h);
    });
    return () => {
      alive = false;
    };
  }, [code, lang]);
  if (!html) return <div className="py-1 pr-12 text-xs text-slate-500">代码高亮加载中…</div>;
  return <div className="py-1 pr-12" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** 表格块：Tiptap Table（块内编辑，Tab 跳格）。 */
export const TableBlock = memo(function TableBlock({ data, selected }: { data: AppNode['data']; selected: boolean }) {
  const block = data.block;
  return (
    <BlockShell
      block={block}
      selected={selected}
      shellClassName="!p-2"
      contentClassName="overflow-auto"
      renderStatic={() => <StaticHtml json={block.content.data} className="py-1" />}
    />
  );
});

/** 代码块：lowlight 静态高亮 + 语言下拉（非编辑态角标切换）。编辑态走 BlockShell Tiptap。 */
export const CodeBlock = memo(function CodeBlock({ data, selected }: { data: AppNode['data']; selected: boolean }) {
  const block = data.block;
  const api = useEditorApi();
  const lang = readCodeLanguage(block.content);
  return (
    <BlockShell
      block={block}
      selected={selected}
      shellClassName="!bg-[var(--code-bg,#0b1020)] !text-[var(--code-fg,#e6edf3)]"
      contentClassName="font-mono text-xs"
      renderStatic={() => {
        const code = extractCodeText(block.content.data);
        return (
        <div className="relative">
          <div className="absolute right-0 top-0 flex items-center gap-1 opacity-70">
            <select
              className="nodrag nowheel cursor-pointer rounded bg-slate-700/80 px-0.5 text-[10px] text-white"
              value={lang}
              title="代码语言"
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => api.updateContent(block.id, setCodeLanguage(block.content.data, e.target.value))}
            >
              {CODE_LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <CodeHtml code={code} lang={lang} />
        </div>
        );
      }}
    />
  );
});

/** 公式块：KaTeX 渲染 + 双击 textarea 编辑源码。 */
export const EquationBlock = memo(function EquationBlock({ data, selected }: { data: AppNode['data']; selected: boolean }) {
  const block = data.block;
  const api = useEditorApi();
  const d = p1d<EquationData>(block);
  const [src, setSrc] = useState(d.source);
  return (
    <BlockShell
      block={block}
      selected={selected}
      shellClassName="items-center justify-center"
      contentClassName="flex items-center justify-center overflow-auto"
      renderStatic={() =>
        d.source ? (
          <EquationHtml source={d.source} />
        ) : (
          <div className="py-3 text-center text-xs text-slate-400">双击编辑公式（$...$）</div>
        )
      }
      renderEditor={() => (
        <textarea
          autoFocus
          defaultValue={d.source}
          placeholder="E = mc^2"
          className="nodrag nowheel m-1 h-24 w-full resize-none rounded border border-blue-300 bg-transparent p-1 font-mono text-xs"
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => setSrc(e.target.value)}
          onBlur={() => api.updateContent(block.id, { kind: 'equation', source: src ?? d.source } satisfies EquationData)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              api.setEditingNode(null);
            }
          }}
        />
      )}
    />
  );
});

/** 网页书签：URL 卡片（不抓网），点击新标签打开；双击编辑 URL/标题/描述。 */
export const BookmarkBlock = memo(function BookmarkBlock({ data, selected }: { data: AppNode['data']; selected: boolean }) {
  const block = data.block;
  const api = useEditorApi();
  const d = p1d<BookmarkData>(block);
  const [draft, setDraft] = useState<BookmarkData>(d);
  return (
    <BlockShell
      block={block}
      selected={selected}
      shellClassName="!p-2"
      contentClassName="flex flex-col justify-center"
      renderStatic={() =>
        d.url ? (
          <a
            href={d.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex flex-col gap-0.5"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="flex items-center gap-1 text-sm font-semibold">
              <ExternalLink size={12} className="shrink-0 text-slate-400" />
              <span className="truncate">{d.title || d.url}</span>
            </span>
            {d.description && <span className="line-clamp-2 text-xs text-slate-500">{d.description}</span>}
            <span className="truncate text-[10px] text-blue-500">{d.url}</span>
          </a>
        ) : (
          <div className="py-2 text-xs text-slate-400">双击粘贴 / 输入网页 URL 成书签</div>
        )
      }
      renderEditor={() => (
        <div className="nodrag nowheel flex flex-col gap-1 p-0.5" onMouseDown={(e) => e.stopPropagation()}>
          <input
            autoFocus
            placeholder="https://…"
            defaultValue={d.url}
            className="w-full rounded border border-blue-300 px-1 text-xs"
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
          />
          <input
            placeholder="标题（可空）"
            defaultValue={d.title}
            className="w-full rounded border border-slate-300 px-1 text-xs"
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          <input
            placeholder="描述（可空）"
            defaultValue={d.description}
            className="w-full rounded border border-slate-300 px-1 text-xs"
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            onBlur={() => api.updateContent(block.id, { ...draft } satisfies BookmarkData)}
          />
        </div>
      )}
    />
  );
});

/** 附件块：上传卡片（图片仍走 image 块）。 */
export const AttachmentBlock = memo(function AttachmentBlock({ data, selected }: { data: AppNode['data']; selected: boolean }) {
  const block = data.block;
  const api = useEditorApi();
  const d = p1d<AttachmentData>(block);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPick = async (file: File | undefined) => {
    if (!file || !api.putImageAsset) return;
    const r = await api.putImageAsset(file);
    api.updateContent(block.id, {
      kind: 'attachment',
      assetRef: r.assetRef,
      name: r.name,
      size: r.size,
      mime: file.type,
    } satisfies AttachmentData);
  };

  return (
    <BlockShell
      block={block}
      selected={selected}
      shellClassName="!p-2"
      contentClassName="flex items-center"
      renderStatic={() => (
        <div className="flex w-full items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => void onPick(e.target.files?.[0])}
          />
          {d.assetRef ? (
            <>
              <FileText size={20} className="shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{d.name}</div>
                <div className="text-[10px] text-slate-400">{formatSize(d.size)}</div>
              </div>
              <button
                title="删除附件"
                className="rounded p-1 text-slate-400 hover:text-red-500"
                onClick={(e) => {
                  e.stopPropagation();
                  api.updateContent(block.id, { kind: 'attachment', assetRef: '', name: '', size: 0, mime: '' } satisfies AttachmentData);
                }}
              >
                <Trash2 size={12} />
              </button>
            </>
          ) : (
            <button
              className="flex w-full items-center justify-center gap-1 rounded border border-dashed border-slate-300 py-2 text-xs text-slate-400"
              onClick={(e) => {
                e.stopPropagation();
                fileRef.current?.click();
              }}
            >
              <Upload size={12} /> 上传附件
            </button>
          )}
        </div>
      )}
    />
  );
});

/** 日期/提醒块：原生 date input 样式化 + 展示格式化日期（P1 不做系统通知）。 */
export const ReminderBlock = memo(function ReminderBlock({ data, selected }: { data: AppNode['data']; selected: boolean }) {
  const block = data.block;
  const api = useEditorApi();
  const d = p1d<ReminderData>(block);
  const [due, setDue] = useState(d.dueAt ? toDateInput(d.dueAt) : '');
  const [note, setNote] = useState(d.note);

  const fmt = d.dueAt
    ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(d.dueAt))
    : '';

  return (
    <BlockShell
      block={block}
      selected={selected}
      shellClassName="!p-2"
      contentClassName="flex items-center"
      renderStatic={() => (
        <div className="flex w-full items-center gap-2">
          <CalendarClock size={18} className="shrink-0 text-rose-400" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium">{fmt || '设置日期/提醒'}</div>
            {d.note && <div className="truncate text-[10px] text-slate-500">{d.note}</div>}
          </div>
        </div>
      )}
      renderEditor={() => (
        <div className="nodrag nowheel flex w-full flex-col gap-1 p-0.5" onMouseDown={(e) => e.stopPropagation()}>
          <input
            type="date"
            className="w-full rounded border border-blue-300 px-1 text-xs"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            onBlur={() =>
              api.updateContent(block.id, {
                kind: 'reminder',
                dueAt: due ? new Date(due + 'T00:00:00').getTime() : 0,
                note,
              } satisfies ReminderData)
            }
          />
          <input
            placeholder="备注（可空）"
            defaultValue={d.note}
            className="w-full rounded border border-slate-300 px-1 text-xs"
            onChange={(e) => setNote(e.target.value)}
            onBlur={() =>
              api.updateContent(block.id, { kind: 'reminder', dueAt: d.dueAt, note } satisfies ReminderData)
            }
          />
        </div>
      )}
    />
  );
});

function toDateInput(ms: number): string {
  const dt = new Date(ms);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
