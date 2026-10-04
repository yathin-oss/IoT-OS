import { IotosError } from '../../core/errors';
import type { BoardDefinition } from '../../core/registry/types';
import { assertNotOption, type ProcessRunner, type RunResult } from '../process/runner';

/**
 * Adapter for Arduino CLI (https://arduino.github.io/arduino-cli/). Builds
 * structured argument lists and parses JSON output defensively, accepting both
 * the 0.3x and 1.x JSON shapes.
 */

type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function parseJsonOutput(stdout: string, what: string): unknown {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new IotosError('TOOL_FAILED', `arduino-cli returned unreadable output for ${what}`, { details: { preview: text.slice(0, 300) } });
  }
}

export interface InstalledCore {
  id: string;
  installed: string;
  latest: string | null;
}

export function parseCoreList(json: unknown): InstalledCore[] {
  const list = Array.isArray(json) ? json : arr(obj(json)['platforms']);
  return list
    .map((p) => {
      const o = obj(p);
      const id = str(o['id']);
      const installed = str(o['installed_version']) ?? str(o['installed']);
      return id && installed ? { id, installed, latest: str(o['latest_version']) ?? str(o['latest']) } : null;
    })
    .filter((x): x is InstalledCore => x !== null);
}

export interface ArduinoLibSearchHit {
  name: string;
  latest: string | null;
  versions: string[];
  author: string | null;
  sentence: string | null;
  architectures: string[];
  website: string | null;
}

export function parseLibSearch(json: unknown): ArduinoLibSearchHit[] {
  return arr(obj(json)['libraries']).map((l) => {
    const o = obj(l);
    const latest = obj(o['latest']);
    const releases = obj(o['releases']);
    const versions = (arr(o['available_versions']).length ? arr(o['available_versions']) : Object.keys(releases)).filter((v): v is string => typeof v === 'string');
    return {
      name: str(o['name']) ?? '',
      latest: str(latest['version']),
      versions: versions.slice().reverse(),
      author: str(latest['author']),
      sentence: str(latest['sentence']),
      architectures: arr(latest['architectures']).filter((a): a is string => typeof a === 'string'),
      website: str(latest['website']),
    };
  });
}

export interface ArduinoInstalledLib {
  name: string;
  version: string;
  location: string | null;
  architectures: string[];
  dependencies: string[];
}

export function parseLibList(json: unknown): ArduinoInstalledLib[] {
  const list = Array.isArray(json) ? json : arr(obj(json)['installed_libraries']);
  return list
    .map((e) => {
      const lib = obj(obj(e)['library']);
      const name = str(lib['name']);
      if (!name) return null;
      return {
        name,
        version: str(lib['version']) ?? '',
        location: str(lib['install_dir']),
        architectures: arr(lib['architectures']).filter((a): a is string => typeof a === 'string'),
        dependencies: arr(lib['dependencies'])
          .map((d) => str(obj(d)['name']))
          .filter((d): d is string => !!d),
      };
    })
    .filter((x): x is ArduinoInstalledLib => x !== null);
}

export interface ArduinoDetectedPort {
  address: string;
  vid: string | null;
  pid: string | null;
  boards: { name: string; fqbn: string }[];
}

export function parseBoardList(json: unknown): ArduinoDetectedPort[] {
  const list = Array.isArray(json) ? json : arr(obj(json)['detected_ports']);
  return list.map((e) => {
    const o = obj(e);
    const port = obj(o['port']);
    const props = obj(port['properties']);
    return {
      address: str(port['address']) ?? '',
      vid: str(props['vid'])?.replace(/^0x/i, '').toUpperCase() ?? null,
      pid: str(props['pid'])?.replace(/^0x/i, '').toUpperCase() ?? null,
      boards: arr(o['matching_boards']).map((b) => ({ name: str(obj(b)['name']) ?? '', fqbn: str(obj(b)['fqbn']) ?? '' })),
    };
  });
}

/** Parses `arduino-cli outdated` (libraries part): name -> newest available version. */
export function parseOutdated(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const o = obj(json);
  const libs = Array.isArray(json) ? [] : arr(o['libraries']);
  for (const e of libs) {
    const lib = obj(obj(e)['library']);
    const release = obj(obj(e)['release']);
    const name = str(lib['name']);
    const latest = str(release['version']);
    if (name && latest) out.set(name, latest);
  }
  return out;
}

export function fqbnFor(board: BoardDefinition, options: Record<string, string>): string {
  const base = board.toolchain.arduino?.fqbn;
  if (!base) throw new IotosError('BUILD_UNSUPPORTED', `${board.name} has no Arduino toolchain definition`);
  const opts = Object.entries(options).filter(([k, v]) => /^[\w-]+$/.test(k) && /^[\w.-]+$/.test(v));
  if (opts.length === 0) return base;
  // Merge with options already present in the base FQBN (e.g. nano cpu=atmega328).
  const [vendor, arch, id, existing] = base.split(':');
  const merged = new Map((existing ?? '').split(',').filter(Boolean).map((kv) => kv.split('=') as [string, string]));
  for (const [k, v] of opts) merged.set(k, v);
  return `${vendor}:${arch}:${id}:${[...merged].map(([k, v]) => `${k}=${v}`).join(',')}`;
}

/** Library spec for install: "Name@1.2.3". Names may contain spaces; no shell is involved. */
export function libSpec(name: string, version?: string): string {
  if (!name.trim() || /[\0\n@]/.test(name) || name.trim().startsWith('-')) throw new IotosError('INVALID_ARGUMENT', `Invalid library name "${name}"`);
  if (version && !/^[\w.+-]+$/.test(version)) throw new IotosError('INVALID_ARGUMENT', `Invalid library version "${version}"`);
  return version ? `${name.trim()}@${version}` : name.trim();
}

export class ArduinoCli {
  constructor(private readonly runner: ProcessRunner) {}

  available(): boolean {
    return this.runner.isAvailable('arduino-cli');
  }

  private async json(args: string[], purpose: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<unknown> {
    const r = await this.runner.run({ tool: 'arduino-cli', args: [...args, '--format', 'json'], timeoutMs, purpose, quiet: true, ...(signal ? { signal } : {}) });
    if (r.exitCode !== 0) throw this.failure(r, purpose);
    return parseJsonOutput(r.stdout, purpose);
  }

  failure(r: RunResult, purpose: string): IotosError {
    const msg = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 500);
    return new IotosError('TOOL_FAILED', `${purpose} failed: ${msg || `exit code ${r.exitCode}`}`, { details: { processId: r.record.id, exitCode: r.exitCode } });
  }

  async version(): Promise<string | null> {
    const j = obj(await this.json(['version'], 'arduino-cli version', 15_000));
    return str(j['VersionString']) ?? str(j['version']);
  }

  async coreList(): Promise<InstalledCore[]> {
    return parseCoreList(await this.json(['core', 'list'], 'List installed board packages'));
  }

  async coreInstall(core: string, indexUrl: string | undefined, signal?: AbortSignal): Promise<RunResult> {
    const urls = indexUrl ? ['--additional-urls', indexUrl] : [];
    const upd = await this.runner.run({ tool: 'arduino-cli', args: ['core', 'update-index', ...urls], timeoutMs: 5 * 60_000, purpose: 'Update board package index', ...(signal ? { signal } : {}) });
    if (upd.exitCode !== 0) throw this.failure(upd, 'Updating the board index');
    return this.runner.run({ tool: 'arduino-cli', args: ['core', 'install', core, ...urls], timeoutMs: 30 * 60_000, purpose: `Install board package ${core}`, ...(signal ? { signal } : {}) });
  }

  async compile(input: { fqbn: string; sketchDir: string; buildPath: string; libraries: string[]; signal?: AbortSignal; onOutput?: (t: string) => void }): Promise<RunResult> {
    const args = ['compile', '--fqbn', input.fqbn, '--build-path', input.buildPath, '--warnings', 'default'];
    for (const lib of input.libraries) args.push('--library', lib);
    args.push(input.sketchDir);
    return this.runner.run({
      tool: 'arduino-cli',
      args,
      timeoutMs: 15 * 60_000,
      purpose: `Compile for ${input.fqbn}`,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onOutput ? { onStdout: input.onOutput, onStderr: input.onOutput } : {}),
    });
  }

  async upload(input: { fqbn: string; port: string; sketchDir: string; inputDir: string; signal?: AbortSignal; onOutput?: (t: string) => void }): Promise<RunResult> {
    return this.runner.run({
      tool: 'arduino-cli',
      args: ['upload', '--fqbn', input.fqbn, '--port', assertNotOption(input.port, 'Port'), '--input-dir', input.inputDir, '--verbose', input.sketchDir],
      timeoutMs: 5 * 60_000,
      purpose: `Upload to ${input.port}`,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onOutput ? { onStdout: input.onOutput, onStderr: input.onOutput } : {}),
    });
  }

  async libSearch(query: string): Promise<ArduinoLibSearchHit[]> {
    if (query.includes('\0')) throw new IotosError('INVALID_ARGUMENT', 'Invalid query');
    // Terms that look like options are dropped so a query can never inject CLI flags.
    const terms = query.trim().split(/\s+/).filter((t) => t && !t.startsWith('-'));
    return parseLibSearch(await this.json(['lib', 'search', ...terms], `Search libraries for "${query}"`, 120_000));
  }

  async libList(): Promise<ArduinoInstalledLib[]> {
    return parseLibList(await this.json(['lib', 'list'], 'List installed libraries'));
  }

  async libInstall(name: string, version?: string): Promise<RunResult> {
    return this.runner.run({ tool: 'arduino-cli', args: ['lib', 'install', libSpec(name, version)], timeoutMs: 10 * 60_000, purpose: `Install library ${name}` });
  }

  async libUninstall(name: string): Promise<RunResult> {
    return this.runner.run({ tool: 'arduino-cli', args: ['lib', 'uninstall', libSpec(name)], timeoutMs: 2 * 60_000, purpose: `Uninstall library ${name}` });
  }

  async libUpgrade(name: string): Promise<RunResult> {
    return this.runner.run({ tool: 'arduino-cli', args: ['lib', 'upgrade', libSpec(name)], timeoutMs: 10 * 60_000, purpose: `Upgrade library ${name}` });
  }

  async libDeps(name: string, version?: string): Promise<{ name: string; required: string | null; installed: string | null }[]> {
    const j = obj(await this.json(['lib', 'deps', libSpec(name, version)], `Resolve dependencies of ${name}`, 120_000));
    return arr(j['dependencies']).map((d) => {
      const o = obj(d);
      return { name: str(o['name']) ?? '', required: str(o['version_required']), installed: str(o['version_installed']) };
    });
  }

  async outdatedLibraries(): Promise<Map<string, string>> {
    return parseOutdated(await this.json(['outdated'], 'Check for library updates', 120_000));
  }

  async boardList(): Promise<ArduinoDetectedPort[]> {
    return parseBoardList(await this.json(['board', 'list'], 'Detect connected boards', 30_000));
  }
}
