import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { IotosError } from '../../core/errors';
import type { ProcessRecord } from '../../core/ipc/contract';
import type { EventBus } from '../events';
import type { Logger } from '../logging/logger';
import { TOOL_SPECS, type ToolId, type ToolResolver } from './tools';

export interface RunOptions {
  tool: ToolId;
  args: string[];
  cwd?: string;
  /** Hard timeout; the process tree is killed when exceeded. */
  timeoutMs: number;
  purpose: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  /** Do not emit output events to the UI (e.g. high-frequency polling). */
  quiet?: boolean;
}

export interface RunResult {
  record: ProcessRecord;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const MAX_CAPTURE = 4 * 1024 * 1024;

/** Environment variables never passed to external tools. */
const SECRET_ENV = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|IOTOS_HOST_TOKEN|IOTOS_.*_BASE_URL)$/;

function toolEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV.test(k)) env[k] = v;
  return { ...env, ...(extra ?? {}), PYTHONUNBUFFERED: '1' };
}

/** Rejects values that a CLI would parse as an option (argument injection). */
export function assertNotOption(value: string, what: string): string {
  if (value.startsWith('-')) throw new IotosError('INVALID_ARGUMENT', `${what} must not start with "-"`);
  return value;
}
const MAX_RECORDS = 200;

function quoteForDisplay(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/**
 * The only way IoT-OS executes external programs.
 *  - Executables come from the ToolResolver allowlist (never from user/AI strings).
 *  - Arguments are passed as an array with shell disabled: no shell parsing, no injection.
 *  - Every run has a timeout and can be cancelled; the whole process group is killed.
 *  - stdout/stderr are captured (bounded) and streamed to the UI with secrets redacted.
 */
export class ProcessRunner {
  private readonly records: ProcessRecord[] = [];
  private readonly outputs = new Map<string, string>();

  constructor(
    private readonly resolver: ToolResolver,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  list(): ProcessRecord[] {
    return [...this.records].reverse();
  }

  output(id: string): string {
    return this.outputs.get(id) ?? '';
  }

  isAvailable(tool: ToolId): boolean {
    return this.resolver.resolve(tool) !== null;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const resolved = this.resolver.resolve(opts.tool);
    if (!resolved) {
      const spec = TOOL_SPECS[opts.tool];
      throw new IotosError('TOOL_MISSING', `${spec.name} is not installed or not on PATH`, {
        details: { tool: opts.tool },
        hint: spec.install ? `${spec.install}${spec.docsUrl ? ` — see ${spec.docsUrl}` : ''}. You can also set its path in Settings → Toolchains.` : undefined,
      });
    }
    for (const a of opts.args) {
      if (typeof a !== 'string' || a.includes('\0')) throw new IotosError('TOOL_NOT_ALLOWED', 'Invalid process argument');
    }
    const args = [...resolved.prefixArgs, ...opts.args];
    const id = randomUUID();
    const record: ProcessRecord = {
      id,
      tool: opts.tool,
      command: this.logger.redact([resolved.exe, ...args].map(quoteForDisplay).join(' ')),
      cwd: opts.cwd ?? null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      status: 'running',
      durationMs: null,
      purpose: opts.purpose,
    };
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) {
      const removed = this.records.shift()!;
      this.outputs.delete(removed.id);
    }
    this.outputs.set(id, '');
    if (!opts.quiet) this.bus.emit('process.started', { ...record });
    const log = this.logger.scope('process');
    log.info(`start ${opts.tool}: ${opts.purpose}`, { id, command: record.command, cwd: opts.cwd });

    const started = Date.now();
    return await new Promise<RunResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      const child = spawn(resolved.exe, args, {
        cwd: opts.cwd,
        env: toolEnv(opts.env),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const killTree = () => {
        if (child.pid === undefined || child.exitCode !== null) return;
        try {
          if (process.platform === 'win32') child.kill();
          else process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        setTimeout(() => {
          if (child.exitCode === null && child.pid !== undefined) {
            try {
              if (process.platform === 'win32') child.kill('SIGKILL');
              else process.kill(-child.pid, 'SIGKILL');
            } catch {
              /* already gone */
            }
          }
        }, 3000).unref();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, opts.timeoutMs);
      const onAbort = () => {
        cancelled = true;
        killTree();
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();

      const append = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (stream === 'stdout') {
          if (stdout.length < MAX_CAPTURE) stdout += text;
          opts.onStdout?.(text);
        } else {
          if (stderr.length < MAX_CAPTURE) stderr += text;
          opts.onStderr?.(text);
        }
        const red = this.logger.redact(text);
        const prev = this.outputs.get(id) ?? '';
        if (prev.length < MAX_CAPTURE) this.outputs.set(id, prev + red);
        if (!opts.quiet) this.bus.emit('process.output', { id, stream, text: red });
      };
      child.stdout!.on('data', (c: Buffer) => append('stdout', c));
      child.stderr!.on('data', (c: Buffer) => append('stderr', c));

      const finish = (exitCode: number | null, err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        record.endedAt = new Date().toISOString();
        record.durationMs = Date.now() - started;
        record.exitCode = exitCode;
        record.status = cancelled ? 'cancelled' : timedOut ? 'timed-out' : exitCode === 0 ? 'succeeded' : 'failed';
        if (!opts.quiet) this.bus.emit('process.exited', { ...record });
        log.info(`exit ${opts.tool} -> ${record.status}`, { id, exitCode, durationMs: record.durationMs });
        if (err) {
          reject(new IotosError('TOOL_FAILED', `Failed to start ${TOOL_SPECS[opts.tool].name}: ${err.message}`, { cause: err }));
          return;
        }
        if (cancelled) {
          reject(new IotosError('TOOL_CANCELLED', `${TOOL_SPECS[opts.tool].name} was cancelled`, { details: { processId: id } }));
          return;
        }
        if (timedOut) {
          reject(new IotosError('TOOL_TIMEOUT', `${TOOL_SPECS[opts.tool].name} timed out after ${Math.round(opts.timeoutMs / 1000)} s`, { details: { processId: id } }));
          return;
        }
        resolve({ record: { ...record }, exitCode, stdout, stderr });
      };
      child.on('error', (err) => finish(null, err));
      child.on('close', (code) => finish(code));
    });
  }
}
