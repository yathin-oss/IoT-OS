import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { AI_PROVIDER_IDS, DEFAULT_MODELS, type AIProviderId } from '../../core/ai/types';
import { IotosError } from '../../core/errors';
import type { PublicSettings, SettingsUpdate } from '../../core/ipc/contract';
import type { SecretStore } from './secrets';

const SettingsSchema = z.object({
  version: z.literal(1).default(1),
  workspaceDir: z.string().min(1),
  ai: z
    .object({
      provider: z.enum(AI_PROVIDER_IDS).default('anthropic'),
      models: z.record(z.string(), z.string()).default({}),
      contextBudgetTokens: z.number().int().min(2000).max(200_000).default(16000),
    })
    .default({ provider: 'anthropic', models: {}, contextBudgetTokens: 16000 }),
  /** Explicit executable paths by tool id; empty = discover on PATH. */
  toolPaths: z.record(z.string(), z.string()).default({}),
  serial: z
    .object({
      defaultBaud: z.number().int().positive().default(115200),
      lineEnding: z.enum(['none', 'lf', 'cr', 'crlf']).default('lf'),
      timestamps: z.boolean().default(true),
      maxLines: z.number().int().min(1000).max(200_000).default(20000),
    })
    .default({ defaultBaud: 115200, lineEnding: 'lf', timestamps: true, maxLines: 20000 }),
  simulator: z.object({ speed: z.number().min(0.1).max(4).default(1) }).default({ speed: 1 }),
  editor: z.object({ fontSize: z.number().int().min(9).max(28).default(13), wordWrap: z.boolean().default(false) }).default({ fontSize: 13, wordWrap: false }),
});
type StoredSettings = z.infer<typeof SettingsSchema>;

export const SECRET_ENV: Record<string, string> = {
  'ai.anthropic': 'ANTHROPIC_API_KEY',
  'ai.openai': 'OPENAI_API_KEY',
  'ai.gemini': 'GEMINI_API_KEY',
};

/** Persistent user settings (non-secret) + access to the secret store. */
export class SettingsService {
  private data: StoredSettings;

  constructor(
    private readonly file: string,
    private readonly secrets: SecretStore,
    defaults: { workspaceDir: string },
    private readonly onSecret?: (value: string) => void,
  ) {
    this.data = this.load(defaults.workspaceDir);
    for (const p of AI_PROVIDER_IDS) {
      const k = this.secrets.get(`ai.${p}`);
      if (k) this.onSecret?.(k);
    }
  }

  private load(workspaceDir: string): StoredSettings {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
        // Never accept secrets from the plain settings file.
        delete raw['apiKey'];
        return SettingsSchema.parse({ workspaceDir, ...raw });
      } catch {
        // A corrupt settings file must not prevent startup; keep a copy for inspection.
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      }
    }
    return SettingsSchema.parse({ workspaceDir });
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  get raw(): Readonly<StoredSettings> {
    return this.data;
  }

  model(provider: AIProviderId): string {
    return this.data.ai.models[provider] || DEFAULT_MODELS[provider];
  }

  apiKey(provider: AIProviderId): string | null {
    return this.secrets.get(`ai.${provider}`);
  }

  toolPath(tool: string): string | null {
    return this.data.toolPaths[tool]?.trim() || null;
  }

  public(): PublicSettings {
    const models = Object.fromEntries(AI_PROVIDER_IDS.map((p) => [p, this.model(p)])) as Record<AIProviderId, string>;
    const hasKey = Object.fromEntries(AI_PROVIDER_IDS.map((p) => [p, this.apiKey(p) !== null])) as Record<AIProviderId, boolean>;
    return {
      workspaceDir: this.data.workspaceDir,
      ai: { provider: this.data.ai.provider, models, hasKey, contextBudgetTokens: this.data.ai.contextBudgetTokens },
      toolPaths: { ...this.data.toolPaths },
      serial: { ...this.data.serial },
      simulator: { ...this.data.simulator },
      editor: { ...this.data.editor },
      secretStorage: this.secrets.kind,
    };
  }

  update(u: SettingsUpdate): PublicSettings {
    const next = {
      ...this.data,
      ...(u.workspaceDir !== undefined ? { workspaceDir: u.workspaceDir } : {}),
      ai: {
        ...this.data.ai,
        ...(u.ai?.provider ? { provider: u.ai.provider } : {}),
        ...(u.ai?.contextBudgetTokens ? { contextBudgetTokens: u.ai.contextBudgetTokens } : {}),
        models: { ...this.data.ai.models, ...Object.fromEntries(Object.entries(u.ai?.models ?? {}).filter(([, v]) => v !== undefined)) },
      },
      toolPaths: u.toolPaths ? Object.fromEntries(Object.entries({ ...this.data.toolPaths, ...u.toolPaths }).filter(([, v]) => v.trim() !== '')) : this.data.toolPaths,
      serial: { ...this.data.serial, ...(u.serial ?? {}) },
      simulator: { ...this.data.simulator, ...(u.simulator ?? {}) },
      editor: { ...this.data.editor, ...(u.editor ?? {}) },
    };
    const parsed = SettingsSchema.safeParse(next);
    if (!parsed.success) {
      throw new IotosError('INVALID_ARGUMENT', `Invalid settings: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    this.data = parsed.data;
    this.persist();
    return this.public();
  }

  setApiKey(provider: AIProviderId, key: string | null): PublicSettings {
    const trimmed = key?.trim() || null;
    if (trimmed && (trimmed.length < 10 || /\s/.test(trimmed))) throw new IotosError('INVALID_ARGUMENT', 'That does not look like an API key');
    this.secrets.set(`ai.${provider}`, trimmed);
    if (trimmed) this.onSecret?.(trimmed);
    return this.public();
  }
}
