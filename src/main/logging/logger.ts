import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogEntry, LogLevel } from '../../core/ipc/contract';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Patterns that look like credentials, redacted from every log line. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /(x-api-key|authorization|api[_-]?key|token|password|secret)(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi,
];

/**
 * Structured logger: JSON lines to a rotating file plus an in-memory ring for the
 * Output panel and diagnostic export. All messages and fields are redacted.
 */
export class Logger {
  private readonly ring: LogEntry[] = [];
  private readonly secrets = new Set<string>();
  private listener: ((e: LogEntry) => void) | null = null;

  constructor(
    private readonly file: string | null,
    private readonly minLevel: LogLevel = 'info',
    private readonly ringSize = 2000,
  ) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  /** Register a concrete secret value (e.g. an API key) to always redact. */
  registerSecret(value: string | null | undefined): void {
    if (value && value.length >= 8) this.secrets.add(value);
  }

  onEntry(fn: (e: LogEntry) => void): void {
    this.listener = fn;
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join('[REDACTED]');
    for (const re of SECRET_PATTERNS) {
      out = out.replace(re, (m, k?: string, sep?: string) => (k && sep !== undefined ? `${k}${sep}[REDACTED]` : '[REDACTED]'));
    }
    return out;
  }

  private write(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    const entry: LogEntry = {
      t: new Date().toISOString(),
      level,
      scope,
      message: this.redact(message),
      ...(fields ? { fields: JSON.parse(this.redact(JSON.stringify(fields, errorReplacer))) as Record<string, unknown> } : {}),
    };
    this.ring.push(entry);
    if (this.ring.length > this.ringSize) this.ring.shift();
    if (this.file) {
      try {
        if ((statSync(this.file, { throwIfNoEntry: false })?.size ?? 0) > MAX_FILE_BYTES) renameSync(this.file, `${this.file}.1`);
        appendFileSync(this.file, JSON.stringify(entry) + '\n');
      } catch (err) {
        // Logging must never crash the app; surface the failure once in the ring.
        this.ring.push({ t: entry.t, level: 'error', scope: 'logger', message: `Failed to write log file: ${(err as Error).message}` });
      }
    }
    this.listener?.(entry);
  }

  scope(name: string): ScopedLogger {
    return {
      debug: (m, f) => this.write('debug', name, m, f),
      info: (m, f) => this.write('info', name, m, f),
      warn: (m, f) => this.write('warn', name, m, f),
      error: (m, f) => this.write('error', name, m, f),
    };
  }

  recent(n = 500): LogEntry[] {
    return this.ring.slice(-n);
  }

  get filePath(): string | null {
    return this.file;
  }
}

export interface ScopedLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function errorReplacer(_k: string, v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, ...('code' in v ? { code: (v as { code: unknown }).code } : {}) };
  return v;
}
