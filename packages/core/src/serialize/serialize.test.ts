import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  serializeKBNote,
  parseKBNote,
  migrate,
  MIGRATION_REGISTRY,
  KBNoteFileError,
} from './serialize.js';
import { createDoc, createNode } from '../model/factory.js';
import { DOC_FORMAT, CURRENT_DOC_VERSION } from '../model/index.js';

describe('serialize / parse round-trip', () => {
  it('round-trips a doc losslessly', () => {
    const doc = createDoc('往返');
    doc.nodes.push(createNode('text', 10, 20), createNode('group', 0, 0));
    doc.edges.push({
      id: 'e_x',
      source: doc.nodes[0]!.id,
      target: doc.nodes[1]!.id,
      sourceHandle: 'right',
      targetHandle: 'left',
      label: '父子',
      directed: true,
      style: { color: '#86EFAC' },
    });
    const text = serializeKBNote(doc);
    const { doc: back, migrationNotes } = parseKBNote(text);
    expect(back.id).toBe(doc.id);
    expect(back.nodes).toHaveLength(2);
    expect(back.edges[0]!.label).toBe('父子');
    expect(back.edges[0]!.style.color).toBe('#86EFAC');
    expect(migrationNotes).toEqual([]);
  });

  it('emits format/version as the first two keys', () => {
    const text = serializeKBNote(createDoc());
    const head = text.slice(0, text.indexOf('\n'));
    expect(head).toBe('{');
    const lines = text.split('\n');
    expect(lines[1]).toContain('"format"');
    expect(lines[2]).toContain('"version"');
  });
});

describe('parseKBNote rejection', () => {
  it('rejects illegal JSON', () => {
    expect(() => parseKBNote('{not json')).toThrow(KBNoteFileError);
    try {
      parseKBNote('{not json');
    } catch (e) {
      expect((e as KBNoteFileError).kind).toBe('invalid-json');
    }
  });

  it('rejects wrong format', () => {
    const bad = JSON.stringify({ format: 'other', version: 1 });
    expect(() => parseKBNote(bad)).toThrow(KBNoteFileError);
    try {
      parseKBNote(bad);
    } catch (e) {
      expect((e as KBNoteFileError).kind).toBe('wrong-format');
    }
  });

  it('rejects a version higher than current', () => {
    expect(CURRENT_DOC_VERSION).toBe(1);
    const future = JSON.stringify({ format: DOC_FORMAT, version: 99, id: 'x' });
    expect(() => parseKBNote(future)).toThrow(KBNoteFileError);
    try {
      parseKBNote(future);
    } catch (e) {
      expect((e as KBNoteFileError).kind).toBe('unsupported-version');
    }
  });
});

describe('migrate registry', () => {
  let original: Record<number, (raw: unknown) => unknown>;
  beforeEach(() => {
    original = { ...MIGRATION_REGISTRY };
  });
  afterEach(() => {
    for (const k of Object.keys(MIGRATION_REGISTRY)) delete MIGRATION_REGISTRY[Number(k)];
    Object.assign(MIGRATION_REGISTRY, original);
  });

  it('runs steps in order from fromVersion to current', () => {
    const calls: string[] = [];
    // Fake a pipeline: current=1. We simulate by bumping: register 0->1, 1->2 then migrate from 0.
    // But currentVersion is fixed at 1; so we test the loop ordering directly:
    // temporarily register steps as if going 0->1 and observe order.
    MIGRATION_REGISTRY[0] = (raw) => {
      calls.push('step0');
      return { ...(raw as object), from0: true };
    };
    MIGRATION_REGISTRY[1] = (raw) => {
      calls.push('step1');
      return { ...(raw as object), from1: true };
    };
    // migrate from 0: loop runs v=0 (<1): step0, v=1; loop ends (v<1 false).
    const res = migrate({ hello: 1 }, 0);
    expect(calls).toEqual(['step0']);
    expect(res.notes).toEqual(['migrated v0 -> v1']);
    expect((res.value as Record<string, unknown>)['from0']).toBe(true);
  });

  it('is identity when fromVersion equals current', () => {
    const raw = { a: 1 };
    const res = migrate(raw, 1);
    expect(res.value).toBe(raw);
    expect(res.notes).toEqual([]);
  });
});
