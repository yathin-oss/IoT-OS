import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { blocksFlash } from '../../core/diagnostics';
import { IotosError, isIotosError } from '../../core/errors';
import type { FlashCheck, FlashResult } from '../../core/ipc/contract';
import { classifyFlashFailure, parseFlashProgress } from '../../core/parsers/tools';
import { BUILD_DIR } from '../../core/project/schema';
import { getRegistry } from '../../core/registry/registry';
import type { BoardDefinition } from '../../core/registry/types';
import type { BuildPipeline } from '../build/buildPipeline';
import { SKETCH_NAME } from '../build/buildPipeline';
import type { DeviceManager } from '../devices/deviceManager';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../logging/logger';
import { assertNotOption, type ProcessRunner, type RunResult } from '../process/runner';
import type { OpenProject, ProjectService } from '../project/projectService';
import type { SerialManager } from '../serial/serialManager';
import { fqbnFor } from '../toolchain/arduinoCli';
import type { ToolchainManager } from '../toolchain/toolchainManager';

interface FlashContext {
  project: OpenProject;
  board: BoardDefinition;
  port: string;
  signal: AbortSignal;
  onOutput: (text: string) => void;
}

/** A way of putting firmware onto a board. */
export interface FlashAdapter {
  readonly id: string;
  readonly tool: 'arduino-cli' | 'mpremote' | 'esptool';
  supports(board: BoardDefinition, language: string): boolean;
  flash(ctx: FlashContext): Promise<RunResult>;
}

export class ArduinoCliUploadAdapter implements FlashAdapter {
  readonly id = 'arduino-cli upload';
  readonly tool = 'arduino-cli' as const;
  constructor(private readonly toolchains: ToolchainManager) {}
  supports(board: BoardDefinition, language: string): boolean {
    return language === 'arduino-cpp' && !!board.toolchain.arduino;
  }
  flash(ctx: FlashContext): Promise<RunResult> {
    const buildRoot = ctx.project.fs.resolve(BUILD_DIR);
    return this.toolchains.arduino.upload({
      fqbn: fqbnFor(ctx.board, ctx.project.model.manifest.toolchain.boardOptions),
      port: ctx.port,
      sketchDir: join(buildRoot, SKETCH_NAME),
      inputDir: join(buildRoot, 'out'),
      signal: ctx.signal,
      onOutput: ctx.onOutput,
    });
  }
}

/** Copies MicroPython sources to the board and resets it (one mpremote session). */
export class MpremoteDeployAdapter implements FlashAdapter {
  readonly id = 'mpremote deploy';
  readonly tool = 'mpremote' as const;
  constructor(private readonly runner: ProcessRunner) {}
  supports(board: BoardDefinition, language: string): boolean {
    return language === 'micropython' && board.languages.includes('micropython');
  }
  async flash(ctx: FlashContext): Promise<RunResult> {
    const files = (await ctx.project.fs.listFiles()).filter((p) => p.startsWith('src/') && p.endsWith('.py'));
    if (files.length === 0) throw new IotosError('ARTIFACT_MISSING', 'No .py files in src/ to deploy');
    const args = ['connect', assertNotOption(ctx.port, 'Port')];
    // Top-level files are copied individually; sub-packages are copied recursively
    // (`cp -r` creates missing directories, unlike `mkdir`, which fails if they exist).
    const topDirs = new Set<string>();
    for (const f of files) {
      const rel = f.slice('src/'.length);
      if (rel.includes('/')) topDirs.add(rel.split('/')[0]!);
      else args.push('fs', 'cp', ctx.project.fs.resolve(f), `:${rel}`, '+');
    }
    for (const d of [...topDirs].sort()) args.push('fs', 'cp', '-r', ctx.project.fs.resolve(`src/${d}`), ':', '+');
    for (const dep of ctx.project.model.manifest.dependencies.filter((d) => d.ecosystem === 'micropython-mip')) {
      if (!/^[\w.@/:-]+$/.test(dep.name) || dep.name.startsWith('-')) throw new IotosError('INVALID_ARGUMENT', `Invalid package name ${dep.name}`);
      args.push('mip', 'install', dep.version ? `${dep.name}@${dep.version}` : dep.name, '+');
    }
    args.push('reset');
    return this.runner.run({ tool: 'mpremote', args, timeoutMs: 5 * 60_000, purpose: `Deploy MicroPython files to ${ctx.port}`, signal: ctx.signal, onStdout: ctx.onOutput, onStderr: ctx.onOutput });
  }
}

/**
 * Flash pipeline: verifies everything that can be verified before touching the
 * device, requires explicit confirmation for ambiguous or risky situations, then
 * runs the real adapter and reports the tool's actual result.
 */
export class FlashPipeline {
  private running: AbortController | null = null;

  constructor(
    private readonly projects: ProjectService,
    private readonly build: BuildPipeline,
    private readonly devices: DeviceManager,
    private readonly serial: SerialManager,
    private readonly runner: ProcessRunner,
    private readonly adapters: FlashAdapter[],
    private readonly bus: EventBus,
    private readonly log: ScopedLogger,
  ) {}

  cancel(): void {
    this.running?.abort();
  }

  private async preflight(project: OpenProject, port: string): Promise<{ board: BoardDefinition | null; adapter: FlashAdapter | null; checks: FlashCheck[] }> {
    const checks: FlashCheck[] = [];
    const add = (id: string, status: FlashCheck['status'], message: string, confirmable = false) => checks.push({ id, status, message, confirmable });
    const { manifest, hardware } = project.model;
    const board = getRegistry().getBoard(hardware.boardId) ?? null;
    if (!board) {
      add('board', 'blocked', `Unknown board "${hardware.boardId}"`);
      return { board, adapter: null, checks };
    }
    add('board', 'ok', `Target board: ${board.name}`);
    if (board.support.flash === 'unsupported') add('board-support', 'blocked', `Flashing ${board.name} is not supported`);
    else if (board.support.flash === 'untested') add('board-support', 'warning', `Flashing ${board.name} has not been verified on real hardware by IoT-OS`, true);

    const diags = await this.projects.diagnostics();
    const gate = blocksFlash(diags.filter((d) => d.source === 'hardware' || d.source === 'project'));
    if (gate.blocked && !gate.overridable) add('hardware', 'blocked', 'The hardware model has blocking problems (see Problems)');
    else if (gate.blocked) add('hardware', 'warning', 'The circuit has wiring errors. Flash only if your physical wiring differs from the circuit.', true);
    else add('hardware', 'ok', 'Hardware validation passed');

    await this.devices.refresh();
    const device = this.devices.get(port);
    if (!device || device.state === 'DISCONNECTED') add('port', 'blocked', `${port} is not connected`);
    else if (device.state === 'PORT_BUSY' && !device.inUse) add('port', 'blocked', `${port} is busy in another program. Close it or use Devices → Diagnose.`);
    else {
      add('port', 'ok', `${port} is connected${device.inUse ? ' (Serial Monitor will be paused during upload)' : ''}`);
      const ids = device.candidates.map((c) => c.boardId);
      if (ids.includes(board.id)) add('identity', 'ok', `USB IDs are consistent with ${board.name}`);
      else if (device.candidates.length) {
        const names = device.candidates.map((c) => getRegistry().getBoard(c.boardId)?.name ?? c.boardId).join(', ');
        add('identity', 'warning', `The device on ${port} looks like ${names}, not ${board.name}`, true);
      } else add('identity', 'warning', `The device on ${port} cannot be identified from its USB IDs (${device.vid ?? '?'}:${device.pid ?? '?'})`, true);
    }

    const adapter = this.adapters.find((a) => a.supports(board, manifest.language)) ?? null;
    if (!adapter) add('adapter', 'blocked', `No flashing method for ${board.name} with ${manifest.language}`);
    else if (!this.runner.isAvailable(adapter.tool)) add('tool', 'blocked', `${adapter.tool} is not installed (see Setup)`);
    else add('tool', 'ok', `Method: ${adapter.id}`);

    const last = this.build.lastResult();
    if (!last || last.status !== 'succeeded' || last.boardId !== board.id) add('artifact', 'blocked', 'No successful build for this board. Build the project first.');
    else {
      const art = last.artifacts.find((a) => a.kind !== 'elf');
      let stale = false;
      for (const f of await project.fs.listFiles()) {
        if (/^(src|include|lib)\//.test(f) && (await stat(project.fs.resolve(f))).mtimeMs > Date.parse(last.startedAt)) stale = true;
      }
      if (stale) add('artifact', 'warning', 'Sources changed since the last build; the uploaded firmware will be out of date', true);
      else add('artifact', 'ok', `Firmware: ${art?.path ?? 'built sources'}`);
    }
    return { board, adapter, checks };
  }

  async run(port: string, confirmed: string[] = []): Promise<FlashResult> {
    if (this.running) throw new IotosError('INVALID_ARGUMENT', 'An upload is already running');
    const project = this.projects.require();
    const started = Date.now();
    const { board, adapter, checks } = await this.preflight(project, port);
    const base = { port, boardId: board?.id ?? project.model.hardware.boardId, method: adapter?.id ?? 'none', checks, failure: null, processId: null };
    if (checks.some((c) => c.status === 'blocked')) {
      const r: FlashResult = { ...base, status: 'blocked', durationMs: Date.now() - started, message: checks.filter((c) => c.status === 'blocked').map((c) => c.message).join(' · ') };
      this.bus.emit('flash.finished', r);
      return r;
    }
    const unconfirmed = checks.filter((c) => c.confirmable && c.status === 'warning' && !confirmed.includes(c.id));
    if (unconfirmed.length) {
      return { ...base, status: 'needs-confirmation', durationMs: Date.now() - started, message: 'Confirm the warnings to continue' };
    }

    const ctrl = new AbortController();
    this.running = ctrl;
    const reopen = await this.serial.releaseFor(port);
    let lastLines = '';
    this.bus.emit('flash.progress', { percent: 0, message: `Uploading with ${adapter!.id}…` });
    let result: FlashResult;
    try {
      const r = await adapter!.flash({
        project,
        board: board!,
        port,
        signal: ctrl.signal,
        onOutput: (text) => {
          lastLines = (lastLines + text).slice(-20_000);
          for (const line of text.split(/[\r\n]+/)) {
            const pct = parseFlashProgress(line);
            if (pct !== null) this.bus.emit('flash.progress', { percent: pct, message: line.trim() });
          }
        },
      });
      const ok = r.exitCode === 0;
      const failure = ok ? null : classifyFlashFailure(`${r.stdout}\n${r.stderr}`);
      result = {
        ...base,
        status: ok ? 'succeeded' : 'failed',
        durationMs: Date.now() - started,
        failure,
        processId: r.record.id,
        message: ok ? `Uploaded to ${port}` : `Upload failed: ${failure!.message}`,
      };
      if (failure?.code === 'PORT_BUSY') this.devices.markBusy(port, true);
    } catch (err) {
      const cancelled = isIotosError(err, 'TOOL_CANCELLED');
      result = {
        ...base,
        status: cancelled ? 'cancelled' : 'failed',
        durationMs: Date.now() - started,
        failure: cancelled ? null : { code: 'UNKNOWN', message: (err as Error).message, hint: isIotosError(err) ? (err.hint ?? '') : '' },
        message: cancelled ? 'Upload cancelled' : (err as Error).message,
      };
    } finally {
      this.running = null;
    }
    if (reopen) {
      // Give USB-CDC devices time to re-enumerate after reset.
      await new Promise((r) => setTimeout(r, 1500));
      await reopen().catch((err) => this.log.warn('could not reopen serial monitor after upload', { error: err }));
    }
    if (result.status === 'succeeded') await this.projects.saveModel({ manifest: { runtime: { ...project.model.manifest.runtime, port } } }).catch(() => undefined);
    this.bus.emit('flash.finished', result);
    this.log.info('flash finished', { status: result.status, port, method: result.method, failure: result.failure?.code });
    return result;
  }
}
