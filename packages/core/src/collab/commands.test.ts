import { describe, it, expect } from 'vitest';
import {
  opAddNode,
  opDeleteNodes,
  opUpdateNode,
  opMoveNodes,
  opAddEdge,
  opDeleteEdge,
  opUpdateEdge,
  opSetDocMeta,
  opSetPage,
  opKindLabel,
  nextOpId,
} from './commands.js';
import { parseEnvelope } from './envelope.js';
import { header, node, edge } from './test-helpers.js';

describe('命令 → op 构造器', () => {
  const h = header('doc_x', 'c_a', 7, '左屏');

  it('全部构造器产出可被 zod 解析的合法信封', () => {
    const builders = [
      opAddNode(h, node('n1')),
      opDeleteNodes(h, ['n1']),
      opUpdateNode(h, 'n1', { x: 1 }),
      opMoveNodes(h, [{ nodeId: 'n1', x: 1, y: 2 }]),
      opAddEdge(h, edge('e1', 'n1', 'n2')),
      opDeleteEdge(h, 'e1'),
      opUpdateEdge(h, 'e1', { label: 'x' }),
      opSetDocMeta(h, { title: 't' }),
      opSetPage(h, { mode: 'flow' }),
    ];
    for (const env of builders) {
      const back = parseEnvelope(JSON.parse(JSON.stringify(env)));
      expect(back.kind).toBe('op');
    }
  });

  it('opId 每次唯一', () => {
    expect(nextOpId()).not.toBe(nextOpId());
  });

  it('opKindLabel 覆盖所有类别', () => {
    const kinds = ['add-node','delete-nodes','update-node','add-edge','delete-edge','update-edge','move-nodes','set-doc-meta','set-page'] as const;
    for (const k of kinds) expect(opKindLabel(k).length).toBeGreaterThan(0);
  });
});
