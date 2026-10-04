import { randomUUID } from 'node:crypto';
import type { Diagnostic } from '../../core/diagnostics';
import { IotosError } from '../../core/errors';
import { parseProjectFile } from '../../core/project/migrations';
import { PROJECT_FILES } from '../../core/project/schema';
import { makeFileChange, resolveSelection, type Proposal, type Selection } from '../../core/proposals/proposal';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../logging/logger';
import type { ProjectService } from '../project/projectService';

const MODEL_FILES: Record<string, 'manifest' | 'hardware' | 'circuit'> = {
  [PROJECT_FILES.manifest]: 'manifest',
  [PROJECT_FILES.hardware]: 'hardware',
  [PROJECT_FILES.circuit]: 'circuit',
};

/**
 * Holds pending change proposals (from AI or generators) for the open project
 * and applies accepted selections. Nothing is written without an explicit apply.
 */
export class ProposalStore {
  private proposals = new Map<string, Proposal>();

  constructor(
    private readonly projects: ProjectService,
    private readonly bus: EventBus,
    private readonly log: ScopedLogger,
  ) {}

  list(): Proposal[] {
    return [...this.proposals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Proposal {
    const p = this.proposals.get(id);
    if (!p) throw new IotosError('PROPOSAL_NOT_FOUND', `Proposal ${id} not found`);
    return p;
  }

  clear(): void {
    this.proposals.clear();
    this.bus.emit('proposals.changed', []);
  }

  /** Build a proposal from desired file contents (null = delete) against current disk state. */
  async create(input: {
    title: string;
    description: string;
    origin: Proposal['origin'];
    files: Record<string, string | null>;
    summaries?: Record<string, string[]>;
    diagnostics?: Diagnostic[];
    notes?: string[];
  }): Promise<Proposal | null> {
    const { fs } = this.projects.require();
    const changes = [];
    for (const [path, after] of Object.entries(input.files)) {
      fs.resolve(path); // rejects paths outside the project
      const before = await fs.readOrNull(path);
      if (before === after) continue;
      if (before === null && after === null) continue;
      changes.push(makeFileChange(path, before, after, input.summaries?.[path] ?? []));
    }
    if (changes.length === 0) return null;
    const proposal: Proposal = {
      id: randomUUID(),
      title: input.title,
      description: input.description,
      origin: input.origin,
      createdAt: new Date().toISOString(),
      changes,
      diagnostics: input.diagnostics ?? [],
      status: 'pending',
      ...(input.notes?.length ? { notes: input.notes } : {}),
    };
    this.proposals.set(proposal.id, proposal);
    this.bus.emit('proposals.changed', this.list());
    this.log.info('proposal created', { id: proposal.id, title: proposal.title, files: changes.map((c) => c.path) });
    return proposal;
  }

  async apply(id: string, selection: Selection): Promise<{ proposal: Proposal; written: string[] }> {
    const proposal = this.get(id);
    if (proposal.status !== 'pending') throw new IotosError('INVALID_ARGUMENT', `Proposal is already ${proposal.status}`);
    const { fs } = this.projects.require();
    const current = new Map<string, string | null>();
    for (const c of proposal.changes) current.set(c.path, await fs.readOrNull(c.path));
    const writes = resolveSelection(proposal, selection, (p) => current.get(p) ?? null);

    // Project model files must stay schema-valid even after partial selection.
    for (const w of writes) {
      const kind = MODEL_FILES[w.path];
      if (!kind) continue;
      if (w.content === null) throw new IotosError('INVALID_ARGUMENT', `${w.path} cannot be deleted`);
      try {
        parseProjectFile(kind, w.content, w.path);
      } catch (err) {
        throw new IotosError('AI_INVALID_PROPOSAL', `The selected changes would make ${w.path} invalid. Accept all changes to this file or none.`, { cause: err });
      }
    }
    const written: string[] = [];
    for (const w of writes) {
      if (w.content === null) await fs.delete(w.path);
      else await fs.write(w.path, w.content);
      written.push(w.path);
    }
    const total = proposal.changes.reduce((n, c) => n + Math.max(1, c.blocks.length), 0);
    const chosen = proposal.changes.reduce((n, c) => {
      const s = selection[c.path] ?? 'all';
      return n + (s === 'all' ? Math.max(1, c.blocks.length) : s === 'none' ? 0 : s.length);
    }, 0);
    proposal.status = chosen === 0 ? 'rejected' : chosen < total ? 'partially-applied' : 'applied';
    this.bus.emit('proposals.changed', this.list());
    this.log.info('proposal applied', { id, status: proposal.status, written });
    if (written.some((p) => p in MODEL_FILES)) await this.projects.reload();
    return { proposal, written };
  }

  reject(id: string): Proposal {
    const p = this.get(id);
    if (p.status === 'pending') p.status = 'rejected';
    this.bus.emit('proposals.changed', this.list());
    return p;
  }
}
