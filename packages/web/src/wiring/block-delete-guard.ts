import type { EditorStoreApi, KBNoteDoc } from '@drawpaper/core';
import { extractDocLinks, linksAffectedByDeleteNodes } from '@drawpaper/core';
import { db } from '@/storage/db';
import { cascadeRemoveLinksAcrossDocs } from '@/storage/link-writes';
import { extractPlainText } from '@/storage/search-index';
import { getWiringUi, useWiringUi } from './ui-store';

/**
 * Wave7 P2.1 删块守卫：删除块前先算跨文档/同文档反链影响。
 *
 * - 影响为 0：保持现状，直接 store.deleteNodes（不弹框、不打扰）；
 * - 影响 > 0：弹确认框（与删文档 ConfirmDialog 视觉一致），列出 incoming/outgoing，
 *   用户选「保留为悬挂链接」或「一并移除这些链接」后才删。
 *
 * 本模块是键盘 Delete / hover 工具条删除 /（e2e 模拟的）唯一入口。
 */

/** 块正文前若干字做摘要（与 create-panels-api.summarizeNode 同口径）。 */
function summarize(node: KBNoteDoc['nodes'][number] | undefined): string {
  if (!node) return '未知块';
  const t = extractPlainText(node.content.data).trim();
  return t ? (t.length > 12 ? t.slice(0, 12) + '…' : t) : '空块';
}

/**
 * 请求删除一批块（editorApi.deleteNodes 的拦截实现）。
 * 异步：impact 需要读 Dexie 全量文档。
 */
export async function requestDeleteNodes(store: EditorStoreApi, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const s = store.getState();
  const current = s.doc;

  // 1) 当前文档 links 实时重建（正文 mark 是主存；未保存的新 mark 也要算进影响）。
  const currentLinks = extractDocLinks(current.id, current.nodes, {
    existingLinks: current.links ?? [],
  });

  // 2) 合并其他 Dexie 文档的 links。
  let stored: KBNoteDoc[] = [];
  try {
    stored = await db.docs.toArray();
  } catch {
    stored = [];
  }
  const allLinks: import('@drawpaper/core').DocRefLink[] = [...currentLinks];
  const docById = new Map<string, KBNoteDoc>();
  for (const d of stored) {
    docById.set(d.id, d);
    allLinks.push(...(d.links ?? []));
  }
  docById.set(current.id, current);

  // 3) 影响分组。
  const { incoming, outgoing } = linksAffectedByDeleteNodes(current.id, new Set(ids), allLinks);
  if (incoming.length === 0 && outgoing.length === 0) {
    // 无影响：保持原行为，直接删。
    store.getState().deleteNodes(ids);
    return;
  }

  // 4) 有影响：格式化清单并弹确认框。
  // incoming：谁链接到本块 → 《来源文档》块「来源块正文摘要」。
  // outgoing：本块链向谁 → 《目标文档》块「目标块正文摘要」。
  const fmtIncoming = (l: { sourceDocId: string; sourceNodeId: string }) => {
    const srcDoc = docById.get(l.sourceDocId);
    const srcNode = srcDoc?.nodes.find((n) => n.id === l.sourceNodeId);
    return `《${srcDoc?.title ?? l.sourceDocId}》块「${summarize(srcNode)}」`;
  };
  const fmtOutgoing = (l: { targetDocId: string; targetNodeId: string }) => {
    const tgtDoc = docById.get(l.targetDocId);
    const tgtNode = tgtDoc?.nodes.find((n) => n.id === l.targetNodeId);
    return `《${tgtDoc?.title ?? l.targetDocId}》块「${summarize(tgtNode)}」`;
  };

  useWiringUi.getState().setBlockDeleteRequest({
    nodeIds: ids,
    incoming: incoming.map(fmtIncoming),
    outgoing: outgoing.map(fmtOutgoing),
    // 级联只删「其他文档」的源 mark；同文档 incoming 由 macro 内存清理。
    incomingLinkIds: incoming.filter((l) => l.sourceDocId !== current.id).map((l) => l.id),
  });
}

/**
 * 用户在确认框里选了某个动作后回调。
 * @param mode 'keep' = 保留为悬挂链接；'remove' = 一并移除这些链接。
 */
export function resolveBlockDeleteRequest(
  store: EditorStoreApi,
  mode: 'keep' | 'remove',
): void {
  const req = getWiringUi().blockDeleteRequest;
  if (!req) return;
  getWiringUi().setBlockDeleteRequest(null);
  if (mode === 'keep') {
    // 保留：仅删块。incoming 链接记录保留 → 目标块缺失后 findDanglingLinks 判 node-missing，
    // chip 下次悬挂判定补 .is-dangling 红虚边。
    store.getState().deleteNodes(req.nodeIds);
    return;
  }
  // 一并移除：同文档 mark 清理 + 删块 = 一个可撤销 macro；
  // 跨文档源 mark 走存储层级联（操作前对每个被改文档快照，可经快照恢复）。
  const incomingIdSet = new Set(req.incomingLinkIds);
  store.getState().deleteNodesWithLinkCleanup(req.nodeIds, incomingIdSet);
  void cascadeRemoveLinksAcrossDocs(incomingIdSet, store.getState().currentDocId);
}
