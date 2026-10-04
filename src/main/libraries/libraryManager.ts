import { IotosError } from '../../core/errors';
import type { DependencyResolution, InstalledLibrary, LibraryEcosystem, LibraryInfo } from '../../core/ipc/contract';
import { requiredDependencies } from '../../core/project/dependencies';
import type { Dependency } from '../../core/project/schema';
import { getRegistry } from '../../core/registry/registry';
import type { BoardDefinition } from '../../core/registry/types';
import type { DeviceManager } from '../devices/deviceManager';
import type { ScopedLogger } from '../logging/logger';
import { assertNotOption, type ProcessRunner } from '../process/runner';
import type { ProjectService } from '../project/projectService';
import type { ArduinoCli } from '../toolchain/arduinoCli';

/** Arduino library "architectures" naming for a board. */
export function arduinoArch(board: BoardDefinition): string[] {
  switch (board.architecture) {
    case 'esp32':
    case 'esp32s3':
    case 'esp32c3':
      return ['esp32'];
    case 'renesas_uno':
      return ['renesas_uno', 'renesas'];
    default:
      return [board.architecture];
  }
}

export function compatibility(architectures: string[], board: BoardDefinition | undefined): 'compatible' | 'incompatible' | 'unknown' {
  if (!board || architectures.length === 0) return 'unknown';
  if (architectures.includes('*')) return 'compatible';
  return arduinoArch(board).some((a) => architectures.includes(a)) ? 'compatible' : 'incompatible';
}

export interface LibraryOpResult {
  ok: boolean;
  message: string;
  processId: string | null;
}

/** A package ecosystem the library manager can talk to. */
export interface LibraryProvider {
  readonly ecosystem: LibraryEcosystem;
  search(query: string, board: BoardDefinition | undefined): Promise<LibraryInfo[]>;
  installed(board: BoardDefinition | undefined): Promise<InstalledLibrary[]>;
  install(name: string, version?: string): Promise<LibraryOpResult>;
  uninstall(name: string): Promise<LibraryOpResult>;
  upgrade(name: string): Promise<LibraryOpResult>;
}

export class ArduinoLibraryProvider implements LibraryProvider {
  readonly ecosystem = 'arduino' as const;
  constructor(private readonly cli: ArduinoCli) {}

  private requireCli(): void {
    if (!this.cli.available()) {
      throw new IotosError('TOOL_MISSING', 'Arduino CLI is required to manage Arduino libraries', { hint: 'Install arduino-cli (see Settings → Toolchains / Setup).' });
    }
  }

  async search(query: string, board: BoardDefinition | undefined): Promise<LibraryInfo[]> {
    this.requireCli();
    const hits = await this.cli.libSearch(query);
    return hits.slice(0, 100).map((h) => ({
      ecosystem: 'arduino',
      name: h.name,
      latest: h.latest,
      versions: h.versions,
      author: h.author,
      sentence: h.sentence,
      architectures: h.architectures,
      compatibility: compatibility(h.architectures, board),
      website: h.website,
    }));
  }

  async installed(board: BoardDefinition | undefined): Promise<InstalledLibrary[]> {
    this.requireCli();
    const libs = await this.cli.libList();
    return libs.map((l) => ({
      ecosystem: 'arduino',
      name: l.name,
      version: l.version,
      latest: null,
      updateAvailable: false,
      location: l.location,
      architectures: l.architectures,
      compatibility: compatibility(l.architectures, board),
      dependencies: l.dependencies,
    }));
  }

  private result(r: { exitCode: number | null; record: { id: string } }, ok: string, fail: string): LibraryOpResult {
    return r.exitCode === 0 ? { ok: true, message: ok, processId: r.record.id } : { ok: false, message: `${fail} (exit ${r.exitCode}). See the Terminal panel for details.`, processId: r.record.id };
  }

  async install(name: string, version?: string): Promise<LibraryOpResult> {
    this.requireCli();
    return this.result(await this.cli.libInstall(name, version), `Installed ${name}${version ? `@${version}` : ''} (with its dependencies)`, `Installing ${name} failed`);
  }
  async uninstall(name: string): Promise<LibraryOpResult> {
    this.requireCli();
    return this.result(await this.cli.libUninstall(name), `Uninstalled ${name}`, `Uninstalling ${name} failed`);
  }
  async upgrade(name: string): Promise<LibraryOpResult> {
    this.requireCli();
    return this.result(await this.cli.libUpgrade(name), `Upgraded ${name}`, `Upgrading ${name} failed`);
  }
}

const MIP_INDEX_URL = 'https://micropython.org/pi/v2/index.json';

interface MipIndex {
  packages?: { name: string; version?: string; description?: string; author?: string; path?: string }[];
}

/**
 * MicroPython packages via mip (micropython-lib). Installation targets the
 * connected board, because mip installs onto the device filesystem.
 */
export class MipLibraryProvider implements LibraryProvider {
  readonly ecosystem = 'micropython-mip' as const;
  private index: { at: number; data: MipIndex } | null = null;

  constructor(
    private readonly runner: ProcessRunner,
    private readonly port: () => string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async loadIndex(): Promise<MipIndex> {
    if (this.index && Date.now() - this.index.at < 30 * 60_000) return this.index.data;
    let res: Response;
    try {
      res = await this.fetchImpl(MIP_INDEX_URL, { signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new IotosError('TOOL_FAILED', `Cannot reach the micropython-lib index: ${(err as Error).message}`, { hint: 'Check your internet connection.' });
    }
    if (!res.ok) throw new IotosError('TOOL_FAILED', `micropython-lib index returned HTTP ${res.status}`);
    const data = (await res.json()) as MipIndex;
    this.index = { at: Date.now(), data };
    return data;
  }

  async search(query: string): Promise<LibraryInfo[]> {
    const idx = await this.loadIndex();
    const q = query.trim().toLowerCase();
    return (idx.packages ?? [])
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q))
      .slice(0, 100)
      .map((p) => ({
        ecosystem: 'micropython-mip',
        name: p.name,
        latest: p.version ?? null,
        versions: p.version ? [p.version] : [],
        author: p.author ?? null,
        sentence: p.description ?? null,
        architectures: [],
        compatibility: 'unknown',
        website: 'https://github.com/micropython/micropython-lib',
      }));
  }

  async installed(): Promise<InstalledLibrary[]> {
    const port = assertNotOption(this.port(), 'Port');
    const r = await this.runner.run({ tool: 'mpremote', args: ['connect', port, 'fs', 'ls', ':lib'], timeoutMs: 30_000, purpose: `List packages on ${port}` });
    if (r.exitCode !== 0) {
      if (/No such file|ENOENT|OSError: \[Errno 2\]/i.test(r.stderr + r.stdout)) return [];
      throw new IotosError('TOOL_FAILED', `mpremote could not list /lib on ${port}`, { details: { processId: r.record.id } });
    }
    return r.stdout
      .split('\n')
      .map((l) => /^\s*\d+\s+(.+?)\/?\s*$/.exec(l)?.[1])
      .filter((n): n is string => !!n && n !== 'ls')
      .map((name) => ({ ecosystem: 'micropython-mip' as const, name: name.replace(/\.mpy$|\.py$/, ''), version: '', latest: null, updateAvailable: false, location: `:lib/${name}`, architectures: [], compatibility: 'unknown' as const, dependencies: [] }));
  }

  private validName(name: string): string {
    if (!/^[\w.@/:-]+$/.test(name) || name.startsWith('-')) throw new IotosError('INVALID_ARGUMENT', `Invalid package name "${name}"`);
    return name;
  }

  async install(name: string, version?: string): Promise<LibraryOpResult> {
    const port = assertNotOption(this.port(), 'Port');
    const spec = version ? `${this.validName(name)}@${this.validName(version)}` : this.validName(name);
    const r = await this.runner.run({ tool: 'mpremote', args: ['connect', port, 'mip', 'install', spec], timeoutMs: 5 * 60_000, purpose: `Install ${spec} on ${port}` });
    return r.exitCode === 0 ? { ok: true, message: `Installed ${spec} on ${port}`, processId: r.record.id } : { ok: false, message: `mip install failed (exit ${r.exitCode})`, processId: r.record.id };
  }

  async uninstall(name: string): Promise<LibraryOpResult> {
    const port = assertNotOption(this.port(), 'Port');
    const n = this.validName(name);
    const r = await this.runner.run({ tool: 'mpremote', args: ['connect', port, 'fs', 'rm', '-r', `:lib/${n}`], timeoutMs: 60_000, purpose: `Remove ${n} from ${port}` });
    return r.exitCode === 0 ? { ok: true, message: `Removed ${n}`, processId: r.record.id } : { ok: false, message: `Removing ${n} failed (exit ${r.exitCode})`, processId: r.record.id };
  }

  async upgrade(name: string): Promise<LibraryOpResult> {
    return this.install(name);
  }
}

/** Facade over providers, aware of the open project. */
export class LibraryManager {
  constructor(
    private readonly providers: Record<LibraryEcosystem, LibraryProvider>,
    private readonly projects: ProjectService,
    private readonly cli: ArduinoCli,
    private readonly log: ScopedLogger,
  ) {}

  private board(): BoardDefinition | undefined {
    const p = this.projects.openProject;
    return p ? getRegistry().getBoard(p.model.hardware.boardId) : undefined;
  }

  provider(e: LibraryEcosystem): LibraryProvider {
    const p = this.providers[e];
    if (!p) throw new IotosError('INVALID_ARGUMENT', `Unknown ecosystem ${e}`);
    return p;
  }

  async search(e: LibraryEcosystem, q: string): Promise<LibraryInfo[]> {
    return this.provider(e).search(q, this.board());
  }

  async installed(e: LibraryEcosystem): Promise<InstalledLibrary[]> {
    const list = await this.provider(e).installed(this.board());
    if (e === 'arduino' && list.length) {
      try {
        const outdated = await this.cli.outdatedLibraries();
        for (const l of list) {
          const latest = outdated.get(l.name);
          if (latest) Object.assign(l, { latest, updateAvailable: true });
        }
      } catch (err) {
        this.log.warn('update check failed', { error: err });
      }
    }
    return list;
  }

  async install(e: LibraryEcosystem, name: string, version: string | undefined, addToProject: boolean): Promise<LibraryOpResult> {
    const r = await this.provider(e).install(name, version);
    if (r.ok && addToProject && this.projects.openProject) await this.declare(e, name, version);
    return r;
  }

  async uninstall(e: LibraryEcosystem, name: string, removeFromProject: boolean): Promise<LibraryOpResult> {
    const r = await this.provider(e).uninstall(name);
    if (r.ok && removeFromProject && this.projects.openProject) {
      const m = this.projects.require().model.manifest;
      await this.projects.saveModel({ manifest: { dependencies: m.dependencies.filter((d) => !(d.ecosystem === e && d.name === name)) } });
    }
    return r;
  }

  upgrade(e: LibraryEcosystem, name: string): Promise<LibraryOpResult> {
    return this.provider(e).upgrade(name);
  }

  private async declare(e: LibraryEcosystem, name: string, version?: string): Promise<void> {
    const m = this.projects.require().model.manifest;
    const deps: Dependency[] = m.dependencies.filter((d) => !(d.ecosystem === e && d.name === name));
    deps.push({ ecosystem: e, name, ...(version ? { version } : {}) });
    await this.projects.saveModel({ manifest: { dependencies: deps } });
  }

  /** Compare declared + circuit-required dependencies with what is installed. */
  async resolve(): Promise<DependencyResolution> {
    const { model } = this.projects.require();
    const board = getRegistry().getBoard(model.hardware.boardId);
    const ecosystem: LibraryEcosystem = model.manifest.language === 'micropython' ? 'micropython-mip' : 'arduino';
    const declared = model.manifest.dependencies.filter((d) => d.ecosystem === ecosystem);
    const required = board ? requiredDependencies(model.circuit, board, model.manifest.language) : [];
    const names = [...new Set([...declared.map((d) => d.name), ...required.map((d) => d.name)])];
    let installed: InstalledLibrary[] | null = null;
    let message = '';
    try {
      installed = await this.provider(ecosystem).installed(board);
    } catch (err) {
      message = (err as Error).message;
    }
    const status = names.map((name) => {
      const decl = declared.find((d) => d.name === name);
      const inst = installed?.find((l) => l.name.toLowerCase() === name.toLowerCase());
      let state: DependencyResolution['status'][number]['state'];
      if (!installed) state = 'unknown';
      else if (!inst) state = 'missing';
      else if (decl?.version && inst.version && decl.version !== inst.version && ecosystem === 'arduino') state = 'version-mismatch';
      else if (!decl) state = 'not-declared';
      else state = 'ok';
      return { name, declaredVersion: decl?.version ?? null, installedVersion: inst?.version || null, state };
    });
    return { ecosystem, declared, required, status, checked: installed !== null, message: message || (installed ? 'Checked against installed libraries.' : '') };
  }
}
