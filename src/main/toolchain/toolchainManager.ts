import { IotosError, isIotosError } from '../../core/errors';
import type { CoreStatus, ToolStatus } from '../../core/ipc/contract';
import { getRegistry } from '../../core/registry/registry';
import type { ScopedLogger } from '../logging/logger';
import type { ProcessRunner } from '../process/runner';
import { TOOL_SPECS, type ToolId, type ToolResolver } from '../process/tools';
import { ArduinoCli, type InstalledCore } from './arduinoCli';

interface VersionProbe {
  args: string[];
  pattern: RegExp;
  /** Minimum supported version (semver-ish, compared numerically). */
  min?: string;
}

const PROBES: Partial<Record<ToolId, VersionProbe>> = {
  'arduino-cli': { args: ['version'], pattern: /Version:\s*([\d.]+)|"VersionString":\s*"([\d.]+)"|arduino-cli\s+(?:alpha\s+)?([\d.]+)/i, min: '0.35.0' },
  esptool: { args: ['version'], pattern: /esptool(?:\.py)?\s+v?([\d.]+)/i, min: '4.0.0' },
  mpremote: { args: ['version'], pattern: /mpremote\s+v?([\d.]+)/i },
  avrdude: { args: ['-?'], pattern: /avrdude version\s+([\d.]+)/i },
  'mpy-cross': { args: ['--version'], pattern: /MicroPython\s+v?([\d.]+)/i },
  python3: { args: ['--version'], pattern: /Python\s+([\d.]+)/i, min: '3.8.0' },
  git: { args: ['--version'], pattern: /git version\s+([\d.]+)/i },
};

/** Tools shown in the toolchain/setup views, in display order. */
export const MANAGED_TOOLS: ToolId[] = ['arduino-cli', 'esptool', 'mpremote', 'avrdude', 'mpy-cross', 'python3', 'git'];

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Toolchain manager: detects installed tools and versions, reports actionable
 * diagnostics, and manages Arduino board packages (cores).
 */
export class ToolchainManager {
  readonly arduino: ArduinoCli;
  private cache: { at: number; statuses: ToolStatus[] } | null = null;

  constructor(
    private readonly runner: ProcessRunner,
    private readonly resolver: ToolResolver,
    private readonly log: ScopedLogger,
  ) {
    this.arduino = new ArduinoCli(runner);
  }

  async probe(id: ToolId): Promise<ToolStatus> {
    const spec = TOOL_SPECS[id];
    const base = { id, name: spec.name, purpose: spec.purpose, docsUrl: spec.docsUrl };
    if (spec.platforms && !spec.platforms.includes(process.platform)) {
      return { ...base, state: 'unsupported', version: null, path: null, message: `Not used on ${process.platform}`, fix: null };
    }
    const resolved = this.resolver.resolve(id);
    if (!resolved) {
      return { ...base, state: 'missing', version: null, path: null, message: `${spec.name} was not found on PATH or in common install locations.`, fix: spec.install };
    }
    const probe = PROBES[id];
    const display = resolved.prefixArgs.length ? `${resolved.exe} ${resolved.prefixArgs.join(' ')}` : resolved.exe;
    if (!probe) return { ...base, state: 'installed', version: null, path: display, message: 'Found', fix: null };
    try {
      const r = await this.runner.run({ tool: id, args: probe.args, timeoutMs: 20_000, purpose: `Detect ${spec.name} version`, quiet: true });
      const m = probe.pattern.exec(`${r.stdout}\n${r.stderr}`);
      const version = m ? (m.slice(1).find((g) => g !== undefined) ?? null) : null;
      if (!version) {
        if (resolved.source === 'python-module') {
          // python3 exists but the module does not.
          this.resolver.invalidate(id);
          return { ...base, state: 'missing', version: null, path: null, message: `Python module "${spec.pythonModule}" is not installed.`, fix: spec.install };
        }
        return { ...base, state: 'error', version: null, path: display, message: `Could not determine the version (exit code ${r.exitCode}).`, fix: spec.install };
      }
      if (probe.min && compareVersions(version, probe.min) < 0) {
        return { ...base, state: 'invalid-version', version, path: display, message: `Version ${version} is older than the supported minimum ${probe.min}.`, fix: spec.install };
      }
      return { ...base, state: 'installed', version, path: display, message: resolved.source === 'settings' ? 'Using the path configured in Settings' : 'Found', fix: null };
    } catch (err) {
      this.log.warn(`probe ${id} failed`, { error: err });
      return { ...base, state: 'error', version: null, path: display, message: isIotosError(err) ? err.message : String(err), fix: spec.install };
    }
  }

  async status(refresh = false): Promise<ToolStatus[]> {
    if (!refresh && this.cache && Date.now() - this.cache.at < 30_000) return this.cache.statuses;
    if (refresh) this.resolver.clearCache();
    const statuses = await Promise.all(MANAGED_TOOLS.map((id) => this.probe(id)));
    this.cache = { at: Date.now(), statuses };
    return statuses;
  }

  async toolState(id: ToolId): Promise<ToolStatus> {
    return (await this.status()).find((s) => s.id === id) ?? this.probe(id);
  }

  /** Board package status for every registry board. Empty installed list if arduino-cli is missing. */
  async cores(): Promise<CoreStatus[]> {
    let installed: InstalledCore[] = [];
    if (this.arduino.available()) {
      try {
        installed = await this.arduino.coreList();
      } catch (err) {
        this.log.warn('core list failed', { error: err });
      }
    }
    const byCore = new Map<string, CoreStatus>();
    for (const b of getRegistry().listBoards()) {
      const tc = b.toolchain.arduino;
      if (!tc) continue;
      const s = byCore.get(tc.core) ?? { core: tc.core, installed: installed.find((c) => c.id === tc.core)?.installed ?? null, boards: [], indexUrl: tc.indexUrl ?? null };
      s.boards.push(b.id);
      byCore.set(tc.core, s);
    }
    return [...byCore.values()];
  }

  async isCoreInstalled(core: string): Promise<boolean> {
    return (await this.arduino.coreList()).some((c) => c.id === core);
  }

  async installCore(boardId: string, signal?: AbortSignal): Promise<{ ok: boolean; message: string; processId: string | null }> {
    const board = getRegistry().requireBoard(boardId);
    const tc = board.toolchain.arduino;
    if (!tc) throw new IotosError('BUILD_UNSUPPORTED', `${board.name} has no Arduino board package`);
    const r = await this.arduino.coreInstall(tc.core, tc.indexUrl, signal);
    const ok = r.exitCode === 0;
    return { ok, message: ok ? `Installed ${tc.core}` : `Installing ${tc.core} failed (exit ${r.exitCode}). See the Terminal panel.`, processId: r.record.id };
  }
}
