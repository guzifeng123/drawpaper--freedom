import { createDoc, createNode, createEdge } from '../model/index.js';
import type { KBNoteDoc, BlockNode, Edge } from '../model/index.js';
import type { CollabState } from './state.js';
import type { OpEnvelope, EnvelopeHeader } from './envelope.js';
import { createCollabState } from './state.js';

/** 单测辅助：构造确定性小文档与信封。 */

export function makeDoc(id?: string): KBNoteDoc {
  const d = createDoc('测试画布');
  if (id) d.id = id;
  return d;
}

export function node(id: string, x = 0, y = 0): BlockNode {
  const n = createNode('text', x, y);
  n.id = id;
  return n;
}

export function edge(id: string, source: string, target: string): Edge {
  const e = createEdge(source, target);
  e.id = id;
  return e;
}

let opSeq = 0;
export function nextOpId(): string {
  opSeq += 1;
  return `op-test-${opSeq}`;
}

export function header(docId: string, clientId: string, lamport: number, tabName = clientId): EnvelopeHeader {
  return {
    v: 1,
    docId,
    clientId,
    tabName,
    tabColor: '#3b82f6',
    lamport,
  };
}

export function opEnv(h: EnvelopeHeader, op: OpEnvelope['op'], opId = nextOpId()): OpEnvelope {
  return { ...h, kind: 'op', opId, op };
}

export function freshState(doc?: KBNoteDoc): CollabState {
  return createCollabState(doc ?? makeDoc());
}

export function resetOpSeq(): void {
  opSeq = 0;
}
