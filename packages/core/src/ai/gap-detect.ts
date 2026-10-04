import type { KBNoteDoc } from '../model/index.js';
import { buildMainTree, connectedComponents, findOrphans } from '../graph/index.js';
import { extractNodePlainText } from './prompts.js';

/**
 * 孤立块 / 逻辑断点检测（纯函数，零 DOM）。
 *
 * 启发式：
 *  1. 叶子块（在主树中无子女）但文本为空 → 「空块/待补」；
 *  2. 与主体（最大连通分量）断开的非单点连通分量 → 「孤立分支」；
 *  3. 完全无边的游离块 → 「游离块」；
 *  4. 主树根 ≥ 2 且节点较多 → 「多根森林，建议指定主根」。
 *
 * 输出 AiGap[] 供「孤立检测」按钮；每条都带可操作的 nodeIds 与中文说明。
 */

export interface AiGap {
  kind: 'empty-leaf' | 'isolated-component' | 'orphan-node' | 'multi-root';
  nodeIds: string[];
  message: string;
}

export function detectAiGaps(doc: KBNoteDoc): AiGap[] {
  const gaps: AiGap[] = [];
  const nodes = doc.nodes;
  if (nodes.length === 0) return gaps;

  const tree = buildMainTree(nodes, doc.edges);

  // 1. 空叶子块。
  for (const n of nodes) {
    const tn = tree.nodes[n.id];
    const isLeaf = !tn || tn.children.length === 0;
    if (!isLeaf) continue;
    const text = extractNodePlainText(n.content.data);
    if (text.length === 0) {
      gaps.push({
        kind: 'empty-leaf',
        nodeIds: [n.id],
        message: `块「${n.id}」是叶子但没有文字内容，可能是待补的占位块。`,
      });
    }
  }

  // 2 / 3. 连通分量：找最大分量，其余非单点分量为孤立分支；单点为游离块。
  const comps = connectedComponents(nodes, doc.edges);
  let main: string[] = [];
  for (const c of comps) if (c.length > main.length) main = c;
  const mainSet = new Set(main);
  for (const c of comps) {
    if (mainSet.has(c[0]!)) continue;
    if (c.length === 1) {
      gaps.push({
        kind: 'orphan-node',
        nodeIds: c,
        message: `块「${c[0]}」与整张画布没有任何连线，是游离块。`,
      });
    } else {
      gaps.push({
        kind: 'isolated-component',
        nodeIds: c,
        message: `有 ${c.length} 个块组成的分支与主体断开（${c.slice(0, 4).join(', ')}${c.length > 4 ? '…' : ''}）。`,
      });
    }
  }

  // 4. 多根森林。
  if (tree.roots.length >= 2 && nodes.length >= 4) {
    gaps.push({
      kind: 'multi-root',
      nodeIds: tree.roots,
      message: `当前有 ${tree.roots.length} 个主树根，建议指定一个主根（${tree.roots.slice(0, 4).join(', ')}${tree.roots.length > 4 ? '…' : ''}）。`,
    });
  }

  // findOrphans 兜底（与连通分量结果去重）。
  const known = new Set(gaps.flatMap((g) => g.nodeIds));
  for (const id of findOrphans(nodes, doc.edges)) {
    if (!known.has(id)) {
      gaps.push({
        kind: 'orphan-node',
        nodeIds: [id],
        message: `块「${id}」不与任何边相连。`,
      });
    }
  }

  return gaps;
}
