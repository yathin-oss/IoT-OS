import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { buildGraph, derivePinMap } from '../../core/circuit/graph';
import type { Diagnostic } from '../../core/diagnostics';
import { IotosError, isIotosError } from '../../core/errors';
import type { ProjectSnapshot, ProjectSummary } from '../../core/ipc/contract';
import { buildProject, type ProjectSpec } from '../../core/project/factory';
import { parseProjectFile, serializeProjectFile } from '../../core/project/migrations';
import {
  CircuitSchema,
  HardwareSchema,
  PROJECT_FILES,
  ProjectManifestSchema,
  emptyCircuit,
  type Circuit,
  type HardwareModel,
  type ProjectManifest,
  type ProjectModel,
} from '../../core/project/schema';
import { getRegistry } from '../../core/registry/registry';
import type { Language } from '../../core/registry/types';
import { checkFirmwareSync, expectedPinSymbols } from '../../core/sync/pinSync';
import { templateSpec } from '../../core/templates/templates';
import { validateHardware } from '../../core/validation/engine';
import type { EventBus } from '../events';
import { ProjectFs } from '../fs/projectFs';
import type { ScopedLogger } from '../logging/logger';
import type { ProcessRunner } from '../process/runner';

interface IndexEntry {
  root: string;
  pinned: boolean;
  lastOpenedAt: string | null;
}

export interface OpenProject {
  fs: ProjectFs;
  model: ProjectModel;
  warnings: string[];
}

export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  );
}

/**
 * Project lifecycle: create/open/save/close/rename/duplicate/delete, workspace
 * index (recent + pinned), and the currently open project.
 */
export class ProjectService {
  private current: OpenProject | null = null;

  constructor(
    private readonly indexFile: string,
    private readonly workspaceDir: () => string,
    private readonly bus: EventBus,
    private readonly log: ScopedLogger,
    private readonly opts: { trash: (abs: string) => Promise<void>; runner?: ProcessRunner; now?: () => Date },
  ) {}

  private now(): string {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }

  /* ----------------------------- index ----------------------------- */

  private async readIndex(): Promise<IndexEntry[]> {
    try {
      const raw = JSON.parse(await readFile(this.indexFile, 'utf8')) as { projects?: IndexEntry[] };
      return Array.isArray(raw.projects) ? raw.projects.filter((p) => typeof p.root === 'string') : [];
    } catch {
      return [];
    }
  }

  private async writeIndex(entries: IndexEntry[]): Promise<void> {
    await mkdir(dirname(this.indexFile), { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ projects: entries }, null, 2));
    await rename(tmp, this.indexFile);
  }

  private async touchIndex(root: string, patch: Partial<IndexEntry>): Promise<void> {
    const entries = await this.readIndex();
    const i = entries.findIndex((e) => e.root === root);
    if (i >= 0) entries[i] = { ...entries[i]!, ...patch };
    else entries.push({ root, pinned: false, lastOpenedAt: null, ...patch });
    await this.writeIndex(entries);
  }

  private async summarize(root: string, entry: IndexEntry | undefined): Promise<ProjectSummary> {
    const base = { root, pinned: entry?.pinned ?? false, lastOpenedAt: entry?.lastOpenedAt ?? null };
    try {
      const text = await readFile(join(root, PROJECT_FILES.manifest), 'utf8');
      const m = parseProjectFile('manifest', text, PROJECT_FILES.manifest).value;
      let boardId: string | null = null;
      let componentCount = 0;
      try {
        boardId = parseProjectFile('hardware', await readFile(join(root, PROJECT_FILES.hardware), 'utf8'), PROJECT_FILES.hardware).value.boardId;
        componentCount = parseProjectFile('circuit', await readFile(join(root, PROJECT_FILES.circuit), 'utf8'), PROJECT_FILES.circuit).value.components.length;
      } catch {
        // Summary still useful without hardware/circuit details.
      }
      return { ...base, id: m.id, name: m.name, description: m.description, boardId, language: m.language, componentCount, updatedAt: m.updatedAt, status: 'ok', tags: m.tags };
    } catch (err) {
      return {
        ...base,
        id: null,
        name: basename(root),
        description: '',
        boardId: null,
        language: null,
        componentCount: 0,
        updatedAt: null,
        status: 'error',
        error: isIotosError(err) ? err.message : (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'Project files are missing (.iotos/project.json not found)' : (err as Error).message,
        tags: [],
      };
    }
  }

  /** Projects in the workspace folder plus any registered elsewhere. */
  async list(): Promise<ProjectSummary[]> {
    const entries = await this.readIndex();
    // Canonical (symlink-resolved) paths so index entries and scanned folders match.
    const canonical = async (p: string) => realpath(p).catch(() => resolve(p));
    const roots = new Set(await Promise.all(entries.map((e) => canonical(e.root))));
    const ws = this.workspaceDir();
    for (const name of await readdir(ws).catch(() => [])) {
      const root = join(ws, name);
      if (await stat(join(root, PROJECT_FILES.manifest)).catch(() => null)) roots.add(await canonical(root));
    }
    const out = await Promise.all([...roots].map((r) => this.summarize(r, entries.find((e) => e.root === r))));
    return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastOpenedAt ?? b.updatedAt ?? '').localeCompare(a.lastOpenedAt ?? a.updatedAt ?? ''));
  }

  async setPinned(root: string, pinned: boolean): Promise<ProjectSummary[]> {
    await this.touchIndex(root, { pinned });
    return this.list();
  }

  /* ---------------------------- lifecycle --------------------------- */

  private async uniqueDir(parent: string, name: string): Promise<string> {
    const base = slugify(name);
    for (let i = 0; i < 1000; i++) {
      const dir = join(parent, i === 0 ? base : `${base}-${i + 1}`);
      if (!(await stat(dir).catch(() => null))) return dir;
    }
    throw new IotosError('PROJECT_EXISTS', `Could not find a free folder name for "${name}"`);
  }

  /** Writes a fully built project to a new folder and opens it. */
  async createFromSpec(spec: ProjectSpec, parentDir?: string): Promise<ProjectSnapshot> {
    const name = spec.name.trim();
    if (!name) throw new IotosError('INVALID_ARGUMENT', 'Project name is required');
    const parent = resolve(parentDir ?? this.workspaceDir());
    await mkdir(parent, { recursive: true });
    const root = await this.uniqueDir(parent, name);
    const built = buildProject(spec, { id: randomUUID(), now: this.now() });
    await mkdir(join(root, '.iotos'), { recursive: true });
    const fs = await ProjectFs.open(root);
    for (const [path, content] of Object.entries(built.files)) await fs.write(path, content);
    await fs.write(PROJECT_FILES.manifest, serializeProjectFile(built.manifest));
    await fs.write(PROJECT_FILES.hardware, serializeProjectFile(built.hardware));
    await fs.write(PROJECT_FILES.circuit, serializeProjectFile(built.circuit));
    await mkdir(join(root, 'lib'), { recursive: true });
    await this.tryGitInit(root);
    this.log.info('project created', { root, template: spec.template ?? null, board: spec.boardId });
    return this.open(root);
  }

  async create(input: { name: string; boardId: string; language: Language; template: string; parentDir?: string }): Promise<ProjectSnapshot> {
    return this.createFromSpec(templateSpec(input.template, input.name, input.boardId, input.language), input.parentDir);
  }

  private async tryGitInit(root: string): Promise<void> {
    const runner = this.opts.runner;
    if (!runner?.isAvailable('git')) return;
    try {
      await runner.run({ tool: 'git', args: ['init', '--quiet'], cwd: root, timeoutMs: 15000, purpose: 'Initialise Git repository', quiet: true });
    } catch (err) {
      this.log.warn('git init failed (project still created)', { error: err });
    }
  }

  /** Load and validate the three project files. */
  static async load(root: string): Promise<{ fs: ProjectFs; model: ProjectModel; warnings: string[] }> {
    const fs = await ProjectFs.open(root);
    const warnings: string[] = [];
    const manifestText = await fs.readOrNull(PROJECT_FILES.manifest);
    if (manifestText === null) {
      throw new IotosError('PROJECT_MANIFEST_MISSING', `${root} is not an IoT-OS project (.iotos/project.json is missing)`, {
        hint: 'Create a new project, or restore .iotos/project.json from version control.',
      });
    }
    const manifest = parseProjectFile('manifest', manifestText, PROJECT_FILES.manifest);
    const hwText = await fs.readOrNull(PROJECT_FILES.hardware);
    if (hwText === null) throw new IotosError('PROJECT_SCHEMA_INVALID', '.iotos/hardware.json is missing; the target board is unknown', { hint: 'Restore the file from version control.' });
    const hardware = parseProjectFile('hardware', hwText, PROJECT_FILES.hardware);
    const circuitText = await fs.readOrNull(PROJECT_FILES.circuit);
    let circuit: Circuit;
    if (circuitText === null) {
      warnings.push('.iotos/circuit.json was missing; starting with an empty circuit. Save to recreate it.');
      circuit = emptyCircuit();
    } else {
      circuit = parseProjectFile('circuit', circuitText, PROJECT_FILES.circuit).value;
    }
    for (const r of [manifest, hardware]) if (r.migrated) warnings.push(`Project files were migrated from schema version ${r.storedVersion}; they will be rewritten on save.`);
    if (!getRegistry().getBoard(hardware.value.boardId)) warnings.push(`Board "${hardware.value.boardId}" is not in the hardware registry.`);
    if (!(await fs.exists(manifest.value.firmware.entry))) warnings.push(`Firmware entry ${manifest.value.firmware.entry} is missing.`);
    return { fs, model: { root: fs.root, manifest: manifest.value, hardware: hardware.value, circuit }, warnings };
  }

  async open(root: string): Promise<ProjectSnapshot> {
    const loaded = await ProjectService.load(resolve(root));
    this.current?.fs.unwatch();
    this.current = loaded;
    loaded.fs.watch((paths, external) => {
      this.bus.emit('fs.changed', { paths, external });
      if (external && paths.some((p) => p.startsWith('.iotos/') && !p.startsWith('.iotos/build'))) {
        void this.reload().catch((err) => this.log.warn('reload after external change failed', { error: err }));
      }
    });
    await this.touchIndex(loaded.fs.root, { lastOpenedAt: this.now() });
    const snap = await this.snapshot();
    this.bus.emit('project.changed', snap);
    this.log.info('project opened', { root: loaded.fs.root, warnings: loaded.warnings.length });
    return snap;
  }

  async reload(): Promise<ProjectSnapshot> {
    const cur = this.require();
    return this.open(cur.fs.root);
  }

  close(): void {
    this.current?.fs.unwatch();
    this.current = null;
    this.bus.emit('project.changed', null);
  }

  get openProject(): OpenProject | null {
    return this.current;
  }

  require(): OpenProject {
    if (!this.current) throw new IotosError('PROJECT_NOT_OPEN', 'No project is open');
    return this.current;
  }

  async snapshot(): Promise<ProjectSnapshot> {
    const cur = this.require();
    return { root: cur.fs.root, manifest: cur.model.manifest, hardware: cur.model.hardware, circuit: cur.model.circuit, tree: await cur.fs.tree(), warnings: cur.warnings };
  }

  async saveModel(update: { hardware?: HardwareModel; circuit?: Circuit; manifest?: Partial<ProjectManifest> }): Promise<ProjectSnapshot> {
    const cur = this.require();
    const fs = cur.fs;
    if (update.hardware) {
      const hw = HardwareSchema.parse(update.hardware);
      await fs.write(PROJECT_FILES.hardware, serializeProjectFile(hw));
      cur.model = { ...cur.model, hardware: hw };
    }
    if (update.circuit) {
      const parsed = CircuitSchema.safeParse(update.circuit);
      if (!parsed.success) throw new IotosError('PROJECT_SCHEMA_INVALID', `Invalid circuit: ${parsed.error.issues[0]?.message}`);
      await fs.write(PROJECT_FILES.circuit, serializeProjectFile(parsed.data));
      cur.model = { ...cur.model, circuit: parsed.data };
    }
    const manifest = ProjectManifestSchema.parse({ ...cur.model.manifest, ...(update.manifest ?? {}), updatedAt: this.now() });
    await fs.write(PROJECT_FILES.manifest, serializeProjectFile(manifest));
    cur.model = { ...cur.model, manifest };
    cur.warnings = cur.warnings.filter((w) => !w.includes('migrated') && !w.includes('circuit.json was missing'));
    const snap = await this.snapshot();
    this.bus.emit('project.changed', snap);
    return snap;
  }

  async rename(root: string, name: string): Promise<ProjectSummary> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 80) throw new IotosError('INVALID_ARGUMENT', 'Project names must be 1-80 characters');
    if (this.current && this.current.fs.root === resolve(root)) {
      await this.saveModel({ manifest: { name: trimmed } });
    } else {
      const { fs, model } = await ProjectService.load(root);
      const manifest = { ...model.manifest, name: trimmed, updatedAt: this.now() };
      await fs.write(PROJECT_FILES.manifest, serializeProjectFile(manifest));
    }
    const entry = (await this.readIndex()).find((e) => e.root === resolve(root));
    return this.summarize(resolve(root), entry);
  }

  async duplicate(root: string, name: string): Promise<ProjectSummary> {
    const src = resolve(root);
    const { model } = await ProjectService.load(src);
    const dest = await this.uniqueDir(dirname(src), name);
    await cp(src, dest, {
      recursive: true,
      filter: (p) => {
        const parts = relative(src, p).split(sep);
        return !(parts[0] === '.git' || (parts[0] === '.iotos' && parts[1] === 'build'));
      },
    });
    const fs = await ProjectFs.open(dest);
    const manifest = { ...model.manifest, id: randomUUID(), name: name.trim() || `${model.manifest.name} copy`, createdAt: this.now(), updatedAt: this.now() };
    await fs.write(PROJECT_FILES.manifest, serializeProjectFile(manifest));
    await this.touchIndex(dest, { lastOpenedAt: null });
    this.log.info('project duplicated', { from: src, to: dest });
    return this.summarize(dest, undefined);
  }

  async delete(root: string): Promise<void> {
    const abs = resolve(root);
    // Only delete folders that are IoT-OS projects.
    if (!(await stat(join(abs, PROJECT_FILES.manifest)).catch(() => null))) {
      throw new IotosError('PROJECT_MANIFEST_MISSING', 'Refusing to delete a folder that is not an IoT-OS project');
    }
    if (this.current?.fs.root === abs) this.close();
    await this.opts.trash(abs);
    await this.writeIndex((await this.readIndex()).filter((e) => e.root !== abs));
    this.log.info('project moved to trash', { root: abs });
  }

  /* --------------------------- diagnostics -------------------------- */

  async diagnostics(): Promise<Diagnostic[]> {
    const cur = this.require();
    const { manifest, hardware, circuit } = cur.model;
    const out: Diagnostic[] = cur.warnings.map((w) => ({ code: 'PROJECT_WARNING', severity: 'warning', source: 'project', message: w }));
    const v = validateHardware(hardware, circuit);
    out.push(...v.diagnostics);
    const board = getRegistry().getBoard(hardware.boardId);
    if (board && v.graph) {
      if (!board.languages.includes(manifest.language)) {
        out.push({ code: 'LANGUAGE_UNSUPPORTED', severity: 'blocking', source: 'project', message: `${board.name} does not support ${manifest.language}` });
      }
      const graph = buildGraph(circuit, board.id);
      const expected = expectedPinSymbols(graph, derivePinMap(graph), manifest.language);
      const files: { path: string; content: string }[] = [];
      for (const path of await cur.fs.listFiles()) {
        if (!/^(src|include)\/.*\.(cpp|h|hpp|ino|c|py)$/.test(path)) continue;
        const content = await cur.fs.readOrNull(path);
        if (content !== null) files.push({ path, content });
      }
      out.push(...checkFirmwareSync({ files, configFile: manifest.firmware.configFile, expected, board }));
    }
    return out;
  }
}
