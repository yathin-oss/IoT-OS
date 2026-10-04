import { diffLines } from 'diff';

/**
 * Line diff split into independently selectable change blocks. Partial
 * acceptance rebuilds the file from the diff parts, choosing the new or old text
 * for each block, so reconstruction is exact (including trailing newlines).
 */

export interface ChangeBlock {
  id: number;
  /** 1-based line in the old file where the block starts. */
  oldStart: number;
  /** 1-based line in the new file where the block starts. */
  newStart: number;
  removed: string[];
  added: string[];
}

interface Part {
  value: string;
  added: boolean;
  removed: boolean;
  /** Block index for changed parts. */
  block?: number;
}

export interface LineDiff {
  parts: Part[];
  blocks: ChangeBlock[];
}

function splitLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function computeLineDiff(before: string, after: string): LineDiff {
  const raw = diffLines(before, after);
  const parts: Part[] = [];
  const blocks: ChangeBlock[] = [];
  let oldLine = 1;
  let newLine = 1;
  let current: ChangeBlock | null = null;
  for (const r of raw) {
    const lines = splitLines(r.value);
    if (r.added || r.removed) {
      if (!current) {
        current = { id: blocks.length, oldStart: oldLine, newStart: newLine, removed: [], added: [] };
        blocks.push(current);
      }
      if (r.removed) {
        current.removed.push(...lines);
        oldLine += lines.length;
      } else {
        current.added.push(...lines);
        newLine += lines.length;
      }
      parts.push({ value: r.value, added: !!r.added, removed: !!r.removed, block: current.id });
    } else {
      current = null;
      oldLine += lines.length;
      newLine += lines.length;
      parts.push({ value: r.value, added: false, removed: false });
    }
  }
  return { parts, blocks };
}

/** Rebuild content applying only the selected blocks. */
export function applyBlocks(diff: LineDiff, selected: ReadonlySet<number> | 'all' | 'none'): string {
  let out = '';
  for (const p of diff.parts) {
    if (p.block === undefined) {
      out += p.value;
      continue;
    }
    const take = selected === 'all' ? true : selected === 'none' ? false : selected.has(p.block);
    if (take ? p.added : p.removed) out += p.value;
  }
  return out;
}

/** FNV-1a 32-bit hash for change-conflict detection (not security). */
export function contentHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
