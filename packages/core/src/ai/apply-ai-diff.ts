import { nanoid } from 'nanoid';
import type { KBNoteDoc, BlockNode, Edge } from '../model/index.js';
import { DEFAULT_EDGE_COLOR } from '../model/edge-colors.js';
import type { AiSuggestion } from './suggestion-schema.js';

/**
 * 把用户勾选（accepted）的 AI 建议应用回文档（纯函数，零 DOM）。
 *
 * 语义（见 §2.5 铁律）：
 *  - add-edge    ：去重后建父子边（source=父 → target=子）；
 *  - set-root    ：只在返回 notes 里标注「建议主根」，不改结构（根由布局层接管）；
 *  - group       ：建一个 group 容器块，把成员块的 parentId 指向它；
 *  - split-block ：在目标块下方建一个兄弟文本块（afterText 作为段落）；
 *  - summarize   ：把目标块内容替换为一段纯文本段落；
 *  - 未勾选 / 非法条：跳过，并在 skipped / notes 里计数说明。
 *
 * 与 store/adapters.ts 旧签名 `applyAIDiff(doc,diff,accepted):KBNoteDoc` 的关系：
 * 旧函数是 P1 预留 stub（抛错）。本函数是真实实现，返回更丰富的 `{doc,...}`；
 * Wave4 由集成方（存储/接线 agent）把 store 动作指向这里。本模块**不** import、
 * 也**不修改** store/adapters.ts。
 */

export interface ApplyAiResult {
  doc: KBNoteDoc;
  /** 实际落库的建议条数。 */
  applied: number;
  /** 被跳过（未勾选 / 非法 / 重复）的说明。 */
  skipped: string[];
  /** 人类可读说明（含 set-root 等结构性提示）。 */
  notes: string[];
}

function paragraphDoc(text: string): unknown {
  return {
    type: 'doc',
    content: text
      ? [{ type: 'paragraph', content: [{ type: 'text', text }] }]
      : [{ type: 'paragraph' }],
  };
}

function makeNode(patch: Partial<BlockNode> & { id: string; type: BlockNode['type'] }): BlockNode {
  return {
    x: 0,
    y: 0,
    width: 260,
    height: 80,
    content: { format: 'tiptap-json', data: paragraphDoc('') },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
    ...patch,
  };
}

function makeEdge(source: string, target: string, label: string): Edge {
  return {
    id: 'e_' + nanoid(8),
    source,
    target,
    sourceHandle: 'right',
    targetHandle: 'left',
    label,
    directed: true,
    style: { color: DEFAULT_EDGE_COLOR.hex },
  };
}

/**
 * @param accepted 要应用的建议下标集合（对应 suggestions 数组顺序）。
 */
export function applyAiSuggestions(
  doc: KBNoteDoc,
  suggestions: AiSuggestion[],
  accepted: ReadonlySet<number>,
): ApplyAiResult {
  const nodes: BlockNode[] = doc.nodes.map((n) => ({ ...n, style: { ...n.style } }));
  const edges: Edge[] = doc.edges.map((e) => ({ ...e, style: { ...e.style } }));
  const notes: string[] = [];
  const skipped: string[] = [];
  let applied = 0;

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const hasEdge = (s: string, t: string): boolean =>
    edges.some((e) => e.source === s && e.target === t);

  suggestions.forEach((s, idx) => {
    if (!accepted.has(idx)) {
      skipped.push(`第 ${idx + 1} 条未勾选，已丢弃。`);
      return;
    }
    try {
      switch (s.kind) {
        case 'add-edge': {
          if (!nodeById.has(s.source) || !nodeById.has(s.target)) {
            skipped.push(`第 ${idx + 1} 条端点缺失，跳过。`);
            return;
          }
          if (hasEdge(s.source, s.target)) {
            skipped.push(`第 ${idx + 1} 条边 ${s.source}->${s.target} 已存在，跳过。`);
            return;
          }
          edges.push(makeEdge(s.source, s.target, s.label ?? ''));
          applied++;
          break;
        }
        case 'set-root': {
          if (!nodeById.has(s.rootNodeId)) {
            skipped.push(`第 ${idx + 1} 条根节点缺失，跳过。`);
            return;
          }
          // 仅标注，不改结构（根由布局/用户决定）。
          notes.push(`建议将「${s.rootNodeId}」设为主根（${s.reason}）。`);
          applied++;
          break;
        }
        case 'group': {
          const members = s.memberNodeIds.filter((id) => nodeById.has(id));
          if (members.length < 2) {
            skipped.push(`第 ${idx + 1} 条有效成员不足 2 个，跳过。`);
            return;
          }
          // 包围盒：把 group 容器放在成员外围。
          const boxes = members.map((id) => nodeById.get(id)!);
          const minX = Math.min(...boxes.map((b) => b.x));
          const minY = Math.min(...boxes.map((b) => b.y));
          const maxX = Math.max(...boxes.map((b) => b.x + b.width));
          const maxY = Math.max(...boxes.map((b) => b.y + b.height));
          const pad = 24;
          const groupId = 'n_' + nanoid(8);
          const groupNode = makeNode({
            id: groupId,
            type: 'group',
            x: minX - pad,
            y: minY - pad,
            width: Math.max(120, maxX - minX + pad * 2),
            height: Math.max(80, maxY - minY + pad * 2),
            content: { format: 'tiptap-json', data: paragraphDoc(s.title ?? '') },
          });
          nodes.push(groupNode);
          nodeById.set(groupId, groupNode);
          for (const m of members) {
            const child = nodeById.get(m);
            if (child) child.parentId = groupId;
          }
          applied++;
          break;
        }
        case 'split-block': {
          const target = nodeById.get(s.targetNodeId);
          if (!target) {
            skipped.push(`第 ${idx + 1} 条目标块缺失，跳过。`);
            return;
          }
          const newNode = makeNode({
            id: 'n_' + nanoid(8),
            type: 'text',
            x: target.x,
            y: target.y + target.height + 20,
            content: { format: 'tiptap-json', data: paragraphDoc(s.afterText) },
          });
          nodes.push(newNode);
          nodeById.set(newNode.id, newNode);
          applied++;
          break;
        }
        case 'summarize': {
          const target = nodeById.get(s.targetNodeId);
          if (!target) {
            skipped.push(`第 ${idx + 1} 条目标块缺失，跳过。`);
            return;
          }
          target.content = { format: 'tiptap-json', data: paragraphDoc(s.newText) };
          applied++;
          break;
        }
      }
    } catch (err) {
      skipped.push(`第 ${idx + 1} 条应用异常：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return {
    doc: { ...doc, nodes, edges, board: { ...doc.board, updatedAt: Date.now() } },
    applied,
    skipped,
    notes,
  };
}
