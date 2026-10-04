import { describe, expect, it } from 'vitest';
import { isIotosError } from '../errors';
import { buildProject } from './factory';
import { parseProjectFile, serializeProjectFile, type Migration } from './migrations';
import { CURRENT_SCHEMA_VERSION } from './schema';
import { templateSpec, TEMPLATES, templateSupports } from '../templates/templates';
import { getRegistry } from '../registry/registry';
import { validateHardware } from '../validation/engine';

const ctx = { id: 'test-project-0001', now: '2026-01-01T00:00:00.000Z' };

function expectError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(isIotosError(e)).toBe(true);
    expect((e as { code: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('project files', () => {
  const built = buildProject(templateSpec('blink', 'Blink', 'esp32-devkit-v1', 'arduino-cpp'), ctx);

  it('round-trips manifest, hardware and circuit', () => {
    for (const [kind, value] of [
      ['manifest', built.manifest],
      ['hardware', built.hardware],
      ['circuit', built.circuit],
    ] as const) {
      const parsed = parseProjectFile(kind, serializeProjectFile(value), `${kind}.json`);
      expect(parsed.value).toEqual(value);
      expect(parsed.migrated).toBe(false);
    }
  });

  it('reports corrupted JSON', () => {
    expectError(() => parseProjectFile('manifest', '{"schemaVersion": 1,', 'project.json'), 'PROJECT_INVALID_JSON');
  });

  it('reports files from a newer IoT-OS', () => {
    const text = JSON.stringify({ ...built.manifest, schemaVersion: CURRENT_SCHEMA_VERSION + 1 });
    expectError(() => parseProjectFile('manifest', text, 'project.json'), 'PROJECT_VERSION_UNSUPPORTED');
  });

  it('reports schema violations with field paths', () => {
    const text = JSON.stringify({ ...built.manifest, language: 'rust', name: '' });
    try {
      parseProjectFile('manifest', text, 'project.json');
      throw new Error('should fail');
    } catch (e) {
      expect((e as Error).message).toMatch(/language/);
      expect((e as Error).message).toMatch(/name/);
    }
  });

  it('rejects duplicate component ids and unsafe paths', () => {
    const circuit = { ...built.circuit, components: [...built.circuit.components, built.circuit.components[0]] };
    expectError(() => parseProjectFile('circuit', JSON.stringify(circuit), 'circuit.json'), 'PROJECT_SCHEMA_INVALID');
    const manifest = { ...built.manifest, firmware: { entry: '../evil.cpp', configFile: 'include/config.h' } };
    expectError(() => parseProjectFile('manifest', JSON.stringify(manifest), 'project.json'), 'PROJECT_SCHEMA_INVALID');
  });

  it('applies migrations from older versions', () => {
    const old = { ...built.hardware, schemaVersion: 0, board: built.hardware.boardId } as Record<string, unknown>;
    delete old['boardId'];
    const migrations: Migration[] = [
      {
        kind: 'hardware',
        from: 0,
        migrate: (doc) => {
          const { board, ...rest } = doc;
          return { ...rest, boardId: board };
        },
      },
    ];
    const parsed = parseProjectFile('hardware', JSON.stringify(old), 'hardware.json', { migrations });
    expect(parsed.migrated).toBe(true);
    expect(parsed.storedVersion).toBe(0);
    expect(parsed.value.boardId).toBe('esp32-devkit-v1');
    // Without the migration step, the old file is rejected with a clear error.
    expectError(() => parseProjectFile('hardware', JSON.stringify(old), 'hardware.json', { migrations: [] }), 'PROJECT_VERSION_UNSUPPORTED');
  });
});

describe('project factory and templates', () => {
  it('generates firmware, config, docs and dependencies', () => {
    const p = buildProject(templateSpec('plant-monitor', 'Plant', 'esp32-devkit-v1', 'arduino-cpp'), ctx);
    expect(Object.keys(p.files).sort()).toEqual(['.gitignore', 'docs/HARDWARE.md', 'docs/SETUP.md', 'include/config.h', 'src/main.cpp']);
    expect(p.files['include/config.h']).toMatch(/#define SOIL1_PIN\s+34/);
    expect(p.files['include/config.h']).toMatch(/#define I2C_SDA\s+21/);
    expect(p.manifest.dependencies.map((d) => d.name)).toEqual(
      expect.arrayContaining(['DHT sensor library', 'Adafruit SSD1306', 'Adafruit GFX Library', 'Adafruit Unified Sensor']),
    );
    expect(p.files['docs/HARDWARE.md']).toMatch(/Hardware list/);
    expect(p.files['docs/SETUP.md']).toMatch(/arduino-cli core install esp32:esp32/);
  });

  it('every template builds without ERROR/BLOCKING diagnostics on every supported board', () => {
    const reg = getRegistry();
    let count = 0;
    for (const t of TEMPLATES) {
      for (const board of reg.listBoards()) {
        for (const lang of board.languages) {
          if (!templateSupports(t, board, lang)) continue;
          const p = buildProject(templateSpec(t.id, t.name, board.id, lang), ctx);
          const v = validateHardware(p.hardware, p.circuit);
          const bad = v.diagnostics.filter((d) => d.severity === 'error' || d.severity === 'blocking');
          expect(bad, `${t.id} on ${board.id}/${lang}: ${bad.map((d) => d.message).join('; ')}`).toEqual([]);
          count++;
        }
      }
    }
    expect(count).toBeGreaterThan(15);
  });

  it('refuses a language the board does not support', () => {
    expectError(() => buildProject({ ...templateSpec('blink', 'x', 'arduino-uno-r3', 'arduino-cpp'), language: 'micropython', files: { 'src/main.py': '' } }, ctx), 'INVALID_ARGUMENT');
  });

  it('refuses specs that supply the generated config file or unsafe paths', () => {
    const spec = templateSpec('blink', 'x', 'esp32-devkit-v1', 'arduino-cpp');
    expectError(() => buildProject({ ...spec, files: { ...spec.files, 'include/config.h': '' } }, ctx), 'INVALID_ARGUMENT');
    expectError(() => buildProject({ ...spec, files: { ...spec.files, '../x.cpp': '' } }, ctx), 'INVALID_ARGUMENT');
  });
});
