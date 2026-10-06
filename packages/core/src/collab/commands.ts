import { nanoid } from 'nanoid';
import type { BlockNode, Edge } from '../model/index.js';
import type { OpEnvelope, EnvelopeHeader } from './envelope.js';
import type {
  CollabOp,
  DocMetaPatch,
  EdgeFieldPatch,
  NodeFieldPatch,
  PagePatch,
} from './ops.js';

/**
 * 本地命令 → op 信封 的纯构造器（阶段 B 用）。
 *
 * 约定：B 端在用户触发 runCommand 成功后，调这里把「命令效果」打包成 op 广播，
 * 并把同一条 op 喂回本端 applyOp 走合并引擎（保证本端/远端走同一条收敛路径）。
 * 每个构造器都接收已由调用方 tick 好的 lamport。
 */

/** 生成新 opId（全局唯一，幂等去重用）。 */
export function nextOpId(): string {
  return `op_${nanoid(12)}`;
}

/** 通用打包。 */
function pack(header: EnvelopeHeader, op: CollabOp): OpEnvelope {
  return { ...header, kind: 'op', opId: nextOpId(), op };
}

// ---- 节点 ----
export function opAddNode(header: EnvelopeHeader, node: BlockNode): OpEnvelope {
  return pack(header, { kind: 'add-node', node });
}

export function opDeleteNodes(header: EnvelopeHeader, nodeIds: string[]): OpEnvelope {
  return pack(header, { kind: 'delete-nodes', nodeIds });
}

export function opUpdateNode(header: EnvelopeHeader, nodeId: string, patch: NodeFieldPatch): OpEnvelope {
  return pack(header, { kind: 'update-node', nodeId, patch });
}

/** 拖拽/布局结果批量打包（moveNode 手势、一键布局）。 */
export function opMoveNodes(
  header: EnvelopeHeader,
  positions: Array<{ nodeId: string; x: number; y: number }>,
): OpEnvelope {
  return pack(header, { kind: 'move-nodes', positions });
}

// ---- 边 ----
export function opAddEdge(header: EnvelopeHeader, edge: Edge): OpEnvelope {
  return pack(header, { kind: 'add-edge', edge });
}

export function opDeleteEdge(header: EnvelopeHeader, edgeId: string): OpEnvelope {
  return pack(header, { kind: 'delete-edge', edgeId });
}

export function opUpdateEdge(header: EnvelopeHeader, edgeId: string, patch: EdgeFieldPatch): OpEnvelope {
  return pack(header, { kind: 'update-edge', edgeId, patch });
}

// ---- 文档元信息 / 分页 ----
export function opSetDocMeta(header: EnvelopeHeader, patch: DocMetaPatch): OpEnvelope {
  return pack(header, { kind: 'set-doc-meta', patch });
}

export function opSetPage(header: EnvelopeHeader, patch: PagePatch): OpEnvelope {
  return pack(header, { kind: 'set-page', patch });
}

/** op 种类的中文短名（日志/调试）。 */
export function opKindLabel(kind: CollabOp['kind']): string {
  switch (kind) {
    case 'add-node': return '新增节点';
    case 'delete-nodes': return '删除节点';
    case 'update-node': return '更新节点';
    case 'add-edge': return '新增边';
    case 'delete-edge': return '删除边';
    case 'update-edge': return '更新边';
    case 'move-nodes': return '批量移动';
    case 'set-doc-meta': return '文档元信息';
    case 'set-page': return '分页设置';
  }
}
