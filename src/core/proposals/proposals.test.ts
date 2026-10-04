import { describe, expect, it } from 'vitest';
import { applyBlocks, computeLineDiff } from './diff';
import { makeFileChange, resolveSelection, summarizeCircuitChange, type Proposal } from './proposal';
import { emptyCircuit } from '../project/schema';
import { addComponent, connect } from '../circuit/operations';

const BEFORE = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n';
const AFTER = 'line1\nLINE2\nline3\nline4\nline5\nline6\nline7\nLINE8\nline9\n';

describe('line diff', () => {
  it('splits changes into independent blocks', () => {
    const d = computeLineDiff(BEFORE, AFTER);
    expect(d.blocks).toEqual([
      { id: 0, oldStart: 2, newStart: 2, removed: ['line2'], added: ['LINE2'] },
      { id: 1, oldStart: 8, newStart: 8, removed: ['line8'], added: ['LINE8', 'line9'] },
    ]);
  });

  it('reconstructs exactly for all / none / partial selections', () => {
    const d = computeLineDiff(BEFORE, AFTER);
    expect(applyBlocks(d, 'all')).toBe(AFTER);
    expect(applyBlocks(d, 'none')).toBe(BEFORE);
    expect(applyBlocks(d, new Set([1]))).toBe('line1\nline2\nline3\nline4\nline5\nline6\nline7\nLINE8\nline9\n');
    expect(applyBlocks(d, new Set([0]))).toBe('line1\nLINE2\nline3\nline4\nline5\nline6\nline7\nline8\n');
  });

  it('handles missing trailing newlines', () => {
    const d = computeLineDiff('a\nb', 'a\nc');
    expect(applyBlocks(d, 'all')).toBe('a\nc');
    expect(applyBlocks(d, 'none')).toBe('a\nb');
  });
});

describe('proposals', () => {
  const proposal = (changes = [makeFileChange('src/main.cpp', BEFORE, AFTER), makeFileChange('docs/NEW.md', null, '# hi\n')]): Proposal => ({
    id: 'p1',
    title: 't',
    description: '',
    origin: 'ai',
    createdAt: '2026-01-01T00:00:00Z',
    changes,
    diagnostics: [],
    status: 'pending',
  });

  it('categorizes changes', () => {
    expect(makeFileChange('.iotos/circuit.json', '{}', '{ }').category).toBe('circuit');
    expect(makeFileChange('include/config.h', '', 'x').category).toBe('config');
    expect(makeFileChange('docs/HARDWARE.md', '', 'x').category).toBe('docs');
  });

  it('resolves full, partial and skipped selections', () => {
    const files: Record<string, string | null> = { 'src/main.cpp': BEFORE, 'docs/NEW.md': null };
    const writes = resolveSelection(proposal(), { 'src/main.cpp': [0], 'docs/NEW.md': 'all' }, (p) => files[p] ?? null);
    expect(writes).toEqual([
      { path: 'src/main.cpp', content: 'line1\nLINE2\nline3\nline4\nline5\nline6\nline7\nline8\n' },
      { path: 'docs/NEW.md', content: '# hi\n' },
    ]);
    expect(resolveSelection(proposal(), { 'src/main.cpp': 'none', 'docs/NEW.md': 'none' }, (p) => files[p] ?? null)).toEqual([]);
  });

  it('refuses to apply when the file changed after the proposal', () => {
    expect(() => resolveSelection(proposal(), {}, (p) => (p === 'src/main.cpp' ? 'edited by user\n' : null))).toThrow(/changed after/);
  });

  it('summarizes circuit changes semantically', () => {
    const before = addComponent(emptyCircuit(), 'led', { x: 0, y: 0 }).circuit;
    let after = addComponent(before, 'resistor', { x: 0, y: 0 }).circuit;
    after = connect(after, { node: 'r1', pin: '1' }, { node: 'board', pin: 'GPIO25' }).circuit;
    expect(summarizeCircuitChange(before, after)).toEqual(['Add R1 (resistor)', 'Connect board.GPIO25 ↔ r1.1']);
  });
});
