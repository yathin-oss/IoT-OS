import type { z } from 'zod';
import { IotosError } from '../errors';
import { CircuitSchema, CURRENT_SCHEMA_VERSION, HardwareSchema, ProjectManifestSchema } from './schema';

export type ProjectFileKind = 'manifest' | 'hardware' | 'circuit';

/** A single step upgrading a raw JSON document from `from` to `from + 1`. */
export interface Migration {
  kind: ProjectFileKind;
  from: number;
  migrate(doc: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Registered migrations. Version 1 is the first released format, so the list is
 * empty; future format changes append a step here and bump CURRENT_SCHEMA_VERSION.
 */
export const MIGRATIONS: Migration[] = [];

const SCHEMAS = {
  manifest: ProjectManifestSchema,
  hardware: HardwareSchema,
  circuit: CircuitSchema,
} satisfies Record<ProjectFileKind, z.ZodType>;

export interface ParseResult<T> {
  value: T;
  /** Version the file was stored with, before migration. */
  storedVersion: number;
  migrated: boolean;
}

/**
 * Parse a project file: JSON -> version check -> migrations -> schema validation.
 * Errors are classified so the UI can show precise recovery guidance.
 */
export function parseProjectFile<K extends ProjectFileKind>(
  kind: K,
  text: string,
  file: string,
  opts: { migrations?: Migration[] } = {},
): ParseResult<z.infer<(typeof SCHEMAS)[K]>> {
  const migrations = opts.migrations ?? MIGRATIONS;
  const current = CURRENT_SCHEMA_VERSION;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new IotosError('PROJECT_INVALID_JSON', `${file} is not valid JSON: ${(err as Error).message}`, {
      details: { file },
      hint: 'The file may be corrupted or partially written. Restore it from version control or fix the JSON syntax.',
    });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new IotosError('PROJECT_SCHEMA_INVALID', `${file} must contain a JSON object`, { details: { file } });
  }
  let doc = raw as Record<string, unknown>;
  const stored = doc['schemaVersion'];
  if (typeof stored !== 'number' || !Number.isInteger(stored) || stored < 0) {
    throw new IotosError('PROJECT_SCHEMA_INVALID', `${file} has no valid "schemaVersion"`, { details: { file } });
  }
  if (stored > current) {
    throw new IotosError(
      'PROJECT_VERSION_UNSUPPORTED',
      `${file} uses schema version ${stored}, but this version of IoT-OS supports up to ${current}.`,
      { details: { file, stored, current }, hint: 'Update IoT-OS to open this project.' },
    );
  }
  let version = stored;
  while (version < current) {
    const step = migrations.find((m) => m.kind === kind && m.from === version);
    if (!step) {
      throw new IotosError('PROJECT_VERSION_UNSUPPORTED', `No migration for ${file} from schema version ${version}`, {
        details: { file, stored, current },
      });
    }
    doc = { ...step.migrate(doc), schemaVersion: version + 1 };
    version++;
  }
  const schema = SCHEMAS[kind];
  const parsed = schema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new IotosError('PROJECT_SCHEMA_INVALID', `${file} is invalid:\n${issues.join('\n')}`, {
      details: { file, issues },
      hint: 'Fix the listed fields or restore the file from version control.',
    });
  }
  return { value: parsed.data as z.infer<(typeof SCHEMAS)[K]>, storedVersion: stored, migrated: stored !== current };
}

export function serializeProjectFile(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}
