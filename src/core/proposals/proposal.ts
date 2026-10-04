import type { Diagnostic } from '../diagnostics';
import { IotosError } from '../errors';
import type { Circuit } from '../project/schema';
import { applyBlocks, computeLineDiff, contentHash, type ChangeBlock } from './diff';

/**
 * General change-proposal mechanism. Every AI or generator change to the project
 * (source, config, hardware, circuit, docs) is expressed as a Proposal, reviewed
 * as a diff and applied fully, partially or not at all. Nothing is written until
 * the user accepts.
 */

export type ChangeCategory = 'source' | 'config' | 'hardware' | 'circuit' | 'docs' | 'project';

export interface FileChange {
  path: string;
  kind: 'create' | 'modify' | 'delete';
  category: ChangeCategory;
  before: string | null;
  after: string | null;
  /** Hash of `before` at proposal time; applying fails if the file changed since. */
  baseHash: string | null;
  blocks: ChangeBlock[];
  /** Human-readable semantic summary (e.g. "Added component LED1"). */
  summary: string[];
}

export type ProposalStatus = 'pending' | 'applied' | 'partially-applied' | 'rejected' | 'failed';

export interface Proposal {
  id: string;
  title: string;
  description: string;
  origin: 'ai' | 'generator';
  createdAt: string;
  changes: FileChange[];
  /** Validation results for the proposed state (hardware validation, schema checks). */
  diagnostics: Diagnostic[];
  status: ProposalStatus;
  /** AI-reported assumptions or uncertainty to surface during review. */
  notes?: string[];
}

export function categorize(path: string): ChangeCategory {
  if (path === '.iotos/circuit.json') return 'circuit';
  if (path === '.iotos/hardware.json') return 'hardware';
  if (path === '.iotos/project.json') return 'project';
  if (/^docs\/|\.md$/i.test(path)) return 'docs';
  if (/config\.(h|py)$/.test(path)) return 'config';
  return 'source';
}

export function makeFileChange(path: string, before: string | null, after: string | null, summary: string[] = []): FileChange {
  const kind: FileChange['kind'] = before === null ? 'create' : after === null ? 'delete' : 'modify';
  const diff = computeLineDiff(before ?? '', after ?? '');
  return {
    path,
    kind,
    category: categorize(path),
    before,
    after,
    baseHash: before === null ? null : contentHash(before),
    blocks: diff.blocks,
    summary,
  };
}

export type Selection = Record<string, 'all' | 'none' | number[]>;

export interface ResolvedWrite {
  path: string;
  /** null = delete */
  content: string | null;
}

/**
 * Computes the writes for a selection, checking that each file still matches the
 * content the proposal was made against.
 */
export function resolveSelection(proposal: Proposal, selection: Selection, current: (path: string) => string | null): ResolvedWrite[] {
  const writes: ResolvedWrite[] = [];
  for (const change of proposal.changes) {
    const sel = selection[change.path] ?? 'all';
    if (sel === 'none' || (Array.isArray(sel) && sel.length === 0)) continue;
    const now = current(change.path);
    const nowHash = now === null ? null : contentHash(now);
    if (nowHash !== change.baseHash) {
      throw new IotosError('PROPOSAL_CONFLICT', `${change.path} changed after the proposal was created`, {
        details: { path: change.path },
        hint: 'Regenerate the proposal against the current file.',
      });
    }
    if (change.kind === 'delete') {
      writes.push({ path: change.path, content: null });
      continue;
    }
    if (sel === 'all' || change.kind === 'create') {
      writes.push({ path: change.path, content: change.after });
      continue;
    }
    const diff = computeLineDiff(change.before ?? '', change.after ?? '');
    writes.push({ path: change.path, content: applyBlocks(diff, new Set(sel)) });
  }
  return writes;
}

/** Semantic summary of a circuit change for review UIs. */
export function summarizeCircuitChange(before: Circuit | null, after: Circuit): string[] {
  const out: string[] = [];
  const b = new Map((before?.components ?? []).map((c) => [c.id, c]));
  const a = new Map(after.components.map((c) => [c.id, c]));
  for (const [id, c] of a) {
    const prev = b.get(id);
    if (!prev) out.push(`Add ${c.label} (${c.type})`);
    else {
      const changedProps = Object.keys({ ...prev.props, ...c.props }).filter((k) => prev.props[k] !== c.props[k]);
      if (changedProps.length) out.push(`Change ${c.label}: ${changedProps.map((k) => `${k} ${String(prev.props[k])} → ${String(c.props[k])}`).join(', ')}`);
      if (prev.type !== c.type) out.push(`Change ${c.label} type ${prev.type} → ${c.type}`);
    }
  }
  for (const [id, c] of b) if (!a.has(id)) out.push(`Remove ${c.label}`);
  const wireKey = (w: Circuit['wires'][number]) => [`${w.from.node}.${w.from.pin}`, `${w.to.node}.${w.to.pin}`].sort().join(' ↔ ');
  const bw = new Set((before?.wires ?? []).map(wireKey));
  const aw = new Set(after.wires.map(wireKey));
  for (const k of aw) if (!bw.has(k)) out.push(`Connect ${k}`);
  for (const k of bw) if (!aw.has(k)) out.push(`Disconnect ${k}`);
  return out;
}
