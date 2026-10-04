import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Secret storage abstraction. API keys never leave the main process and are
 * never written to settings.json or logs.
 *
 *  - SafeStorageSecretStore: encrypted with the OS keychain via Electron safeStorage.
 *  - FileSecretStore: fallback (browser-host/dev, or no keychain) — a 0600-permission
 *    file in the app data directory. Documented in docs/SECURITY.md.
 *
 * Environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) take
 * precedence and are read-only.
 */
export interface SecretStore {
  readonly kind: 'os-keychain' | 'file';
  get(name: string): string | null;
  set(name: string, value: string | null): void;
}

function atomicWrite(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // chmod is a no-op on Windows; the file lives in the per-user profile there.
  }
}

function readJson(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;
  constructor(private readonly file: string) {}
  get(name: string): string | null {
    return readJson(this.file)[name] ?? null;
  }
  set(name: string, value: string | null): void {
    const all = readJson(this.file);
    if (value === null) delete all[name];
    else all[name] = value;
    atomicWrite(this.file, JSON.stringify(all));
  }
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(data: Buffer): string;
}

export class SafeStorageSecretStore implements SecretStore {
  readonly kind = 'os-keychain' as const;
  constructor(
    private readonly file: string,
    private readonly safe: SafeStorageLike,
  ) {}
  get(name: string): string | null {
    const enc = readJson(this.file)[name];
    if (!enc) return null;
    try {
      return this.safe.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return null;
    }
  }
  set(name: string, value: string | null): void {
    const all = readJson(this.file);
    if (value === null) delete all[name];
    else all[name] = this.safe.encryptString(value).toString('base64');
    atomicWrite(this.file, JSON.stringify(all));
  }
}

/** Wraps a store so environment variables override stored values. */
export class EnvOverrideSecretStore implements SecretStore {
  constructor(
    private readonly inner: SecretStore,
    private readonly env: Record<string, string | undefined>,
    private readonly mapping: Record<string, string>,
  ) {}
  get kind() {
    return this.inner.kind;
  }
  get(name: string): string | null {
    const envName = this.mapping[name];
    const fromEnv = envName ? this.env[envName] : undefined;
    return fromEnv && fromEnv.trim() ? fromEnv.trim() : this.inner.get(name);
  }
  set(name: string, value: string | null): void {
    this.inner.set(name, value);
  }
}
