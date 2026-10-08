import { memo, useEffect, useState } from 'react';
import { Blocks, RefreshCw, Unlink } from 'lucide-react';
import type { BlockNode } from '@drawpaper/core';
import { parseDocEmbedData } from '@drawpaper/core';
import { db } from '@/storage/db';
import { BlockShell } from './BlockShell';
import { StaticHtml } from '../tiptap/static';
import { useResolvedImageSrc } from './use-resolved-image';
import { useEditorApi } from '../canvas/editor-context';
import type { AppNode } from './types';

/**
 * Wave20 跨画布只读「块嵌入」。
 *
 * 数据：host type='note'，content.data = {kind:'doc-embed', targetDocId, targetNodeId, titleSnapshot}。
 * 渲染：只读静态展示目标块正文（StaticHtml 复用 Tiptap 静态管线，不可编辑）；
 * 顶部「嵌入图标 + 来源画布标题 + 手动刷新」；点击主体 → openDocRef 跳转目标。
 * 生命周期：挂载（打开文档/切换画布/刷新）时从 Dexie 解析目标最新内容——目标改了即见新版；
 * 目标块/文档被删 → 虚线悬挂占位（独立 class .doc-embed--dangling）。
 */

type Resolved =
  | { status: 'loading' }
  | { status: 'ok'; docTitle: string; target: BlockNode }
  | { status: 'dangling' };

function EmbedImage({ src, alt }: { src: string; alt?: string }) {
  const resolved = useResolvedImageSrc(src);
  if (!resolved) {
    return <div className="rounded border border-dashed border-slate-300 bg-slate-50 p-2 text-center text-[10px] text-slate-400">含图片的嵌入</div>;
  }
  return <img src={resolved} alt={alt ?? ''} className="max-h-40 max-w-full rounded object-contain" draggable={false} />;
}

/** 目标块正文：富文本静态渲染；图片块额外渲染图片本体（OPFS 跨文档全局可解析）。 */
function EmbedBody({ target }: { target: BlockNode }) {
  const hasDoc =
    target.content.data && typeof target.content.data === 'object' &&
    (target.content.data as { type?: string }).type === 'doc';
  return (
    <div className="min-w-0">
      {hasDoc ? <StaticHtml json={target.content.data} className="text-[13px]" /> : null}
      {target.type === 'image' && target.image?.src ? <EmbedImage src={target.image.src} alt={target.image.alt} /> : null}
    </div>
  );
}

export const DocEmbedBlock = memo(function DocEmbedBlock({ data, selected }: { data: AppNode['data']; selected: boolean }) {
  const block = data.block;
  const api = useEditorApi();
  const emb = parseDocEmbedData(block.content?.data);

  const [nonce, setNonce] = useState(0);
  const [resolved, setResolved] = useState<Resolved>({ status: 'loading' });
  // 切换画布后即使 node id 撞上也强制重解析（挂载即解析，此处兜底同 id 复用）。
  const currentDocId = api.getState().doc.id;

  useEffect(() => {
    if (!emb) return;
    let cancelled = false;
    setResolved({ status: 'loading' });
    void (async () => {
      try {
        const doc = await db.docs.get(emb.targetDocId);
        const target = doc?.nodes.find((n) => n.id === emb.targetNodeId);
        if (cancelled) return;
        if (!doc || !target) {
          setResolved({ status: 'dangling' });
        } else {
          setResolved({ status: 'ok', docTitle: doc.title || '未命名画布', target });
        }
      } catch {
        if (!cancelled) setResolved({ status: 'dangling' });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emb?.targetDocId, emb?.targetNodeId, currentDocId, nonce]);

  if (!emb) return null;

  const sourceTitle =
    resolved.status === 'ok' ? resolved.docTitle : emb.titleSnapshot || '已删除的画布';

  const body = (() => {
    if (resolved.status === 'loading') {
      return <div className="py-3 text-xs text-slate-400">加载嵌入…</div>;
    }
    if (resolved.status === 'dangling') {
      return (
        <div data-embed-dangling className="flex flex-col items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-3 text-center">
          <Unlink size={14} className="text-slate-400" />
          <span className="text-xs text-slate-400">原块已删除 / 不可用</span>
          {emb.titleSnapshot ? <span className="text-[10px] text-slate-300">{emb.titleSnapshot}</span> : null}
        </div>
      );
    }
    return (
      <div
        data-embed-target
        className="cursor-pointer rounded-md border border-sky-200/70 bg-white/70 px-2 py-1.5 transition-colors hover:border-sky-400"
        title="点击跳转到原块"
        onClick={(e) => {
          e.stopPropagation();
          api.openDocRef?.(emb.targetDocId, emb.targetNodeId);
        }}
      >
        <EmbedBody target={resolved.target} />
      </div>
    );
  })();

  return (
    <BlockShell
      block={block}
      selected={selected}
      shellClassName={resolved.status === 'dangling' ? 'doc-embed--dangling !border-dashed !bg-slate-50' : '!border-sky-200 !bg-sky-50/50'}
      contentClassName="flex flex-col"
      renderStatic={() => (
        <div data-embed-node={emb.targetNodeId} className="flex h-full min-h-0 w-full flex-col">
          {/* 顶部：嵌入图标 + 来源画布标题 + 刷新 */}
          <div data-embed-source className="flex shrink-0 items-center gap-1 border-b border-sky-100 pb-1 pt-2 text-[10px] text-sky-700/80">
            <Blocks size={11} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate font-medium">{sourceTitle}</span>
            <button
              title="刷新嵌入内容"
              className="shrink-0 rounded p-0.5 text-sky-400 hover:text-sky-600"
              onClick={(e) => {
                e.stopPropagation();
                setNonce((n) => n + 1);
              }}
            >
              <RefreshCw size={11} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden pt-1">{body}</div>
        </div>
      )}
      /* 嵌入只读：双击不进入 Tiptap 编辑，给一条只读说明。 */
      renderEditor={() => (
        <div className="py-3 text-center text-xs text-slate-400">嵌入块为只读视图 —— 点击内容可跳转到原块编辑</div>
      )}
    />
  );
});
