import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { blocksBuild, type Diagnostic } from '../../core/diagnostics';
import { IotosError, isIotosError } from '../../core/errors';
import type { BuildResult, BuildStep, BuildStepId } from '../../core/ipc/contract';
import { parseCompilerOutput, parseSizeReport, type PathMapping } from '../../core/parsers/compiler';
import { libraryForHeader } from '../../core/project/dependencies';
import { BUILD_DIR } from '../../core/project/schema';
import { getRegistry } from '../../core/registry/registry';
import type { BoardDefinition } from '../../core/registry/types';
import type { EventBus } from '../events';
import type { LibraryManager } from '../libraries/libraryManager';
import type { ScopedLogger } from '../logging/logger';
import type { ProcessRunner } from '../process/runner';
import type { OpenProject, ProjectService } from '../project/projectService';
import { fqbnFor } from '../toolchain/arduinoCli';
import type { ToolchainManager } from '../toolchain/toolchainManager';

const STEP_TITLES: Record<BuildStepId, string> = {
  'validate-project': 'Validate project',
  'validate-hardware': 'Validate hardware',
  'check-sync': 'Check firmware ↔ circuit pins',
  'resolve-dependencies': 'Resolve dependencies',
  'select-toolchain': 'Select toolchain',
  compile: 'Compile & link',
  artifact: 'Firmware artifact',
};

export const SKETCH_NAME = 'sketch';

class StepFailure extends Error {
  constructor(
    message: string,
    readonly blocked = false,
  ) {
    super(message);
  }
}

/** Walk a directory (relative paths). */
async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(abs, base)));
    else if (e.isFile()) out.push(abs.slice(base.length + 1).split('\\').join('/'));
  }
  return out;
}

/**
 * Build pipeline. Every step reports real status; the compile step runs the
 * actual toolchain and the result reflects its exit code and output.
 */
export class BuildPipeline {
  private running: AbortController | null = null;
  private last: BuildResult | null = null;

  constructor(
    private readonly projects: ProjectService,
    private readonly toolchains: ToolchainManager,
    private readonly libraries: LibraryManager,
    private readonly runner: ProcessRunner,
    private readonly bus: EventBus,
    private readonly log: ScopedLogger,
  ) {}

  lastResult(): BuildResult | null {
    return this.last;
  }

  cancel(): void {
    this.running?.abort();
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  async run(): Promise<BuildResult> {
    if (this.running) throw new IotosError('INVALID_ARGUMENT', 'A build is already running');
    const project = this.projects.require();
    const ctrl = new AbortController();
    this.running = ctrl;
    const id = randomUUID();
    const started = Date.now();
    const { manifest, hardware } = project.model;
    const steps: BuildStep[] = (Object.keys(STEP_TITLES) as BuildStepId[]).map((s) => ({ id: s, title: STEP_TITLES[s], status: 'pending', durationMs: null, detail: null }));
    const diagnostics: Diagnostic[] = [];
    const outputTail: string[] = [];
    const result: BuildResult = {
      id,
      status: 'failed',
      startedAt: new Date(started).toISOString(),
      durationMs: 0,
      boardId: hardware.boardId,
      fqbn: null,
      language: manifest.language,
      steps,
      diagnostics,
      artifacts: [],
      size: null,
      outputTail,
      processId: null,
      message: '',
    };
    const emit = () => this.bus.emit('build.progress', { buildId: id, steps: steps.map((s) => ({ ...s })) });
    const step = async (sid: BuildStepId, fn: () => Promise<{ status?: BuildStep['status']; detail?: string } | void>) => {
      const s = steps.find((x) => x.id === sid)!;
      s.status = 'running';
      emit();
      const t0 = Date.now();
      try {
        const r = (await fn()) ?? {};
        s.status = r.status ?? 'ok';
        s.detail = r.detail ?? null;
      } catch (err) {
        s.status = 'failed';
        s.detail = (err as Error).message;
        throw err;
      } finally {
        s.durationMs = Date.now() - t0;
        emit();
      }
    };

    try {
      const board = getRegistry().getBoard(hardware.boardId);
      await step('validate-project', async () => {
        if (!board) throw new StepFailure(`Unknown board "${hardware.boardId}"`, true);
        if (!board.languages.includes(manifest.language)) throw new StepFailure(`${board.name} does not support ${manifest.language}`, true);
        if (!(await project.fs.exists(manifest.firmware.entry))) throw new StepFailure(`Firmware entry ${manifest.firmware.entry} does not exist`, true);
        return { detail: `${board.name} · ${manifest.language}` };
      });
      const all = await this.projects.diagnostics();
      await step('validate-hardware', async () => {
        const hw = all.filter((d) => d.source === 'hardware' || d.source === 'project');
        diagnostics.push(...hw);
        if (blocksBuild(hw)) throw new StepFailure(`Blocking hardware problems: ${hw.filter((d) => d.severity === 'blocking').map((d) => d.message).join('; ')}`, true);
        const errs = hw.filter((d) => d.severity === 'error').length;
        const warns = hw.filter((d) => d.severity === 'warning').length;
        return errs || warns ? { status: 'warning', detail: `${errs} error(s), ${warns} warning(s) — wiring errors do not block compilation but will block upload` } : { detail: 'No problems' };
      });
      await step('check-sync', async () => {
        const sync = all.filter((d) => d.source === 'sync');
        diagnostics.push(...sync);
        const mism = sync.filter((d) => d.code === 'SYNC_PIN_MISMATCH').length;
        return mism ? { status: 'warning', detail: `${mism} pin definition(s) disagree with the circuit` } : { detail: sync.length ? `${sync.length} note(s)` : 'Firmware pins match the circuit' };
      });

      if (manifest.language === 'arduino-cpp') await this.buildArduino(project, board!, result, step, ctrl.signal);
      else await this.buildMicroPython(project, result, step, ctrl.signal);
      result.status = 'succeeded';
      result.message = 'Build succeeded';
    } catch (err) {
      if (isIotosError(err, 'TOOL_CANCELLED') || ctrl.signal.aborted) {
        result.status = 'cancelled';
        result.message = 'Build cancelled';
      } else if (err instanceof StepFailure) {
        result.status = err.blocked ? 'blocked' : 'failed';
        result.message = err.message;
      } else {
        result.status = 'failed';
        result.message = isIotosError(err) ? err.message : `Build error: ${(err as Error).message}`;
        if (isIotosError(err) && err.hint) result.message += ` — ${err.hint}`;
        this.log.error('build failed unexpectedly', { error: err });
      }
      for (const s of steps) if (s.status === 'pending') s.status = 'skipped';
    } finally {
      this.running = null;
    }
    result.durationMs = Date.now() - started;
    this.last = result;
    await this.persist(project, result);
    this.bus.emit('build.finished', result);
    this.log.info('build finished', { status: result.status, durationMs: result.durationMs });
    return result;
  }

  private async persist(project: OpenProject, result: BuildResult): Promise<void> {
    try {
      await project.fs.write(`${BUILD_DIR}/last-build.json`, JSON.stringify(result, null, 2));
    } catch (err) {
      this.log.warn('could not persist build result', { error: err });
    }
  }

  private async buildArduino(
    project: OpenProject,
    board: BoardDefinition,
    result: BuildResult,
    step: (id: BuildStepId, fn: () => Promise<{ status?: BuildStep['status']; detail?: string } | void>) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const { manifest } = project.model;
    const cliStatus = await this.toolchains.toolState('arduino-cli');
    const cliOk = cliStatus.state === 'installed';

    await step('resolve-dependencies', async () => {
      if (!cliOk) return { status: 'skipped', detail: 'Arduino CLI is required to check installed libraries' };
      const res = await this.libraries.resolve();
      const missing = res.status.filter((s) => s.state === 'missing');
      for (const m of missing) {
        result.diagnostics.push({ code: 'LIBRARY_MISSING', severity: 'error', source: 'toolchain', message: `Library "${m.name}" is not installed`, hint: 'Install it from the Libraries view.' });
      }
      if (missing.length) throw new StepFailure(`Missing libraries: ${missing.map((m) => m.name).join(', ')}. Install them from the Libraries view.`);
      const mismatch = res.status.filter((s) => s.state === 'version-mismatch');
      return mismatch.length
        ? { status: 'warning', detail: mismatch.map((m) => `${m.name}: project wants ${m.declaredVersion}, installed ${m.installedVersion}`).join('; ') }
        : { detail: `${res.status.length} librar${res.status.length === 1 ? 'y' : 'ies'} OK` };
    });

    let fqbn = '';
    await step('select-toolchain', async () => {
      if (!cliOk) throw new StepFailure(`${cliStatus.message}${cliStatus.fix ? ` Install: ${cliStatus.fix}` : ''}`);
      const tc = board.toolchain.arduino;
      if (!tc) throw new StepFailure(`${board.name} has no Arduino toolchain`, true);
      if (!(await this.toolchains.isCoreInstalled(tc.core))) {
        result.diagnostics.push({ code: 'CORE_MISSING', severity: 'error', source: 'toolchain', message: `Board package ${tc.core} is not installed`, hint: 'Install it from Devices → Toolchains or the Setup checklist.' });
        throw new StepFailure(`Board package ${tc.core} is not installed. Install it from the Setup checklist.`);
      }
      fqbn = fqbnFor(board, manifest.toolchain.boardOptions);
      result.fqbn = fqbn;
      return { detail: `arduino-cli ${cliStatus.version} · ${fqbn}` };
    });

    const buildRoot = project.fs.resolve(BUILD_DIR);
    const sketchDir = join(buildRoot, SKETCH_NAME);
    const outDir = join(buildRoot, 'out');
    await step('compile', async () => {
      const mappings = await this.stage(project, sketchDir);
      await mkdir(outDir, { recursive: true });
      const libDir = project.fs.resolve('lib');
      const libraries = (await readdir(libDir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => join(libDir, e.name));
      const r = await this.toolchains.arduino.compile({ fqbn, sketchDir, buildPath: outDir, libraries, signal });
      result.processId = r.record.id;
      const output = `${r.stdout}\n${r.stderr}`;
      result.outputTail.push(...output.split('\n').filter(Boolean).slice(-80));
      const parsed = parseCompilerOutput(output, { pathMappings: [...mappings, { from: project.fs.root, to: '' }] });
      for (const d of parsed) {
        if (d.code === 'MISSING_HEADER') {
          const header = /^([\w./+-]+):/.exec(d.message)?.[1];
          const lib = header ? libraryForHeader(header, board) : null;
          if (lib) d.hint = `Install the "${lib}" library (Libraries view), or let IoT-OS add it as a project dependency.`;
        }
      }
      result.diagnostics.push(...parsed);
      result.size = parseSizeReport(output);
      if (r.exitCode !== 0) {
        const errs = parsed.filter((d) => d.severity === 'error').length;
        throw new StepFailure(errs ? `Compilation failed with ${errs} error(s)` : `Compiler exited with code ${r.exitCode}`);
      }
      const warns = parsed.filter((d) => d.severity === 'warning').length;
      return warns ? { status: 'warning', detail: `${warns} warning(s)` } : { detail: 'No compiler errors' };
    });

    await step('artifact', async () => {
      const files = await readdir(outDir).catch(() => [] as string[]);
      for (const f of files) {
        const kind = f.endsWith('.hex') && !f.includes('with_bootloader') ? 'hex' : f.endsWith('.bin') && !/bootloader|partitions|boot_app/.test(f) ? 'bin' : f.endsWith('.elf') ? 'elf' : f.endsWith('.uf2') ? 'uf2' : null;
        if (!kind) continue;
        const st = await stat(join(outDir, f));
        result.artifacts.push({ path: `${BUILD_DIR}/out/${f}`, kind, bytes: st.size });
      }
      if (!result.artifacts.some((a) => a.kind !== 'elf')) throw new StepFailure('The compiler reported success but produced no firmware image');
      const s = result.size;
      return { detail: s ? `${s.programBytes} bytes program${s.programMax ? ` (${Math.round((s.programBytes / s.programMax) * 100)}%)` : ''}${s.dataBytes !== undefined ? `, ${s.dataBytes} bytes RAM` : ''}` : result.artifacts.map((a) => a.path).join(', ') };
    });
  }

  /** Copy firmware into an arduino-cli sketch layout; returns path mappings for diagnostics. */
  private async stage(project: OpenProject, sketchDir: string): Promise<PathMapping[]> {
    await rm(sketchDir, { recursive: true, force: true });
    await mkdir(join(sketchDir, 'src'), { recursive: true });
    await writeFile(join(sketchDir, `${SKETCH_NAME}.ino`), '// Generated by IoT-OS. The firmware lives in src/ (copied from the project).\n');
    const mappings: PathMapping[] = [];
    const placed = new Map<string, string>();
    for (const dir of ['src', 'include']) {
      const abs = project.fs.resolve(dir);
      for (const rel of await walk(abs)) {
        if (!/\.(c|cpp|cc|h|hpp|hh|S|inc)$/i.test(rel)) continue;
        // include/ headers are flattened into src/ so `#include "config.h"` resolves.
        const target = dir === 'include' ? rel.split('/').pop()! : rel;
        const prev = placed.get(target);
        if (prev) throw new StepFailure(`${dir}/${rel} and ${prev} would collide in the build; rename one of them`);
        placed.set(target, `${dir}/${rel}`);
        const dest = join(sketchDir, 'src', target);
        await mkdir(join(dest, '..'), { recursive: true });
        await cp(join(abs, rel), dest);
        mappings.push({ from: dest, to: `${dir}/${rel}` });
      }
    }
    return mappings;
  }

  private async buildMicroPython(
    project: OpenProject,
    result: BuildResult,
    step: (id: BuildStepId, fn: () => Promise<{ status?: BuildStep['status']; detail?: string } | void>) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    await step('resolve-dependencies', async () => {
      const mip = project.model.manifest.dependencies.filter((d) => d.ecosystem === 'micropython-mip');
      return { status: mip.length ? 'warning' : 'ok', detail: mip.length ? `mip packages are installed on the device at upload time: ${mip.map((d) => d.name).join(', ')}` : 'No packages' };
    });
    let checker: 'mpy-cross' | 'python3' = 'python3';
    await step('select-toolchain', async () => {
      const mpy = await this.toolchains.toolState('mpy-cross');
      if (mpy.state === 'installed') {
        checker = 'mpy-cross';
        return { detail: `mpy-cross ${mpy.version}` };
      }
      const py = await this.toolchains.toolState('python3');
      if (py.state !== 'installed') throw new StepFailure('Neither mpy-cross nor Python 3 is available to check MicroPython sources.');
      return { status: 'warning', detail: 'Using CPython syntax check (install mpy-cross for exact MicroPython checking)' };
    });
    const files = (await project.fs.listFiles()).filter((p) => p.startsWith('src/') && p.endsWith('.py'));
    await step('compile', async () => {
      const outDir = project.fs.resolve(`${BUILD_DIR}/mpy`);
      await mkdir(outDir, { recursive: true });
      for (const f of files) {
        const abs = project.fs.resolve(f);
        const r =
          checker === 'mpy-cross'
            ? await this.runner.run({ tool: 'mpy-cross', args: ['-o', join(outDir, f.replace(/\//g, '_').replace(/\.py$/, '.mpy')), abs], timeoutMs: 60_000, purpose: `Check ${f}`, signal })
            : await this.runner.run({
                tool: 'python3',
                args: ['-c', 'import ast,sys\nsrc=open(sys.argv[1],encoding="utf-8").read()\nast.parse(src, sys.argv[1])', abs],
                timeoutMs: 60_000,
                purpose: `Syntax-check ${f}`,
                signal,
              });
        result.processId = r.record.id;
        if (r.exitCode !== 0) {
          const text = `${r.stdout}\n${r.stderr}`;
          result.outputTail.push(...text.split('\n').filter(Boolean).slice(-20));
          const line = Number(/line (\d+)/.exec(text)?.[1] ?? 0) || undefined;
          const msg = /(SyntaxError|IndentationError|TabError)[^\n]*/.exec(text)?.[0] ?? text.trim().split('\n').pop() ?? 'Syntax error';
          result.diagnostics.push({ code: 'PY_SYNTAX_ERROR', severity: 'error', source: 'compiler', message: msg, target: { file: f, ...(line ? { line } : {}) } });
        }
      }
      const errs = result.diagnostics.filter((d) => d.code === 'PY_SYNTAX_ERROR').length;
      if (errs) throw new StepFailure(`${errs} file(s) have syntax errors`);
      return { detail: `${files.length} file(s) checked` };
    });
    await step('artifact', async () => {
      for (const f of files) result.artifacts.push({ path: f, kind: 'py', bytes: (await stat(project.fs.resolve(f))).size });
      return { detail: `${files.length} file(s) to deploy` };
    });
  }

  /** Intel HEX of the last successful AVR build, for the simulator. */
  async firmwareHex(): Promise<{ hex: string; builtAt: string; stale: boolean } | null> {
    const project = this.projects.require();
    const last = this.last ?? (await this.loadPersisted(project));
    if (!last || last.status !== 'succeeded') return null;
    const art = last.artifacts.find((a) => a.kind === 'hex');
    if (!art) return null;
    const hex = await project.fs.readOrNull(art.path);
    if (hex === null) return null;
    const builtAt = Date.parse(last.startedAt);
    let stale = false;
    for (const f of await project.fs.listFiles()) {
      if (!/^(src|include|lib)\//.test(f)) continue;
      if ((await stat(project.fs.resolve(f))).mtimeMs > builtAt) {
        stale = true;
        break;
      }
    }
    return { hex, builtAt: last.startedAt, stale };
  }

  private async loadPersisted(project: OpenProject): Promise<BuildResult | null> {
    try {
      return JSON.parse(await readFile(project.fs.resolve(`${BUILD_DIR}/last-build.json`), 'utf8')) as BuildResult;
    } catch {
      return null;
    }
  }
}
