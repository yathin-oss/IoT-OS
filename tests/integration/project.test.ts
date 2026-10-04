import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServices } from './helpers';

let t: ReturnType<typeof testServices>;
beforeEach(() => {
  t = testServices();
});
afterEach(async () => {
  await t.dispose();
});

describe('project lifecycle', () => {
  it('creates a project from a template with the canonical layout', async () => {
    const snap = await t.call('project.create', { name: 'My Blink', boardId: 'esp32-devkit-v1', language: 'arduino-cpp', template: 'blink' });
    expect(snap.root).toMatch(/my-blink$/);
    for (const f of ['.iotos/project.json', '.iotos/hardware.json', '.iotos/circuit.json', 'src/main.cpp', 'include/config.h', 'docs/HARDWARE.md', 'docs/SETUP.md']) {
      expect(existsSync(join(snap.root, f)), f).toBe(true);
    }
    expect(existsSync(join(snap.root, 'src/main.py'))).toBe(false);
    expect(snap.manifest.name).toBe('My Blink');
    expect(snap.tree.map((n) => n.name)).toEqual(expect.arrayContaining(['src', 'include', 'docs']));
    expect(await t.call('project.diagnostics')).toEqual([]);
  });

  it('lists, pins, renames, duplicates and deletes projects', async () => {
    const a = await t.call('project.create', { name: 'Alpha', boardId: 'arduino-uno-r3', language: 'arduino-cpp', template: 'button-led' });
    await t.call('project.create', { name: 'Beta', boardId: 'rpi-pico', language: 'micropython', template: 'blink' });
    let list = await t.call('project.list');
    expect(list.map((p) => p.name).sort()).toEqual(['Alpha', 'Beta']);
    expect(list.find((p) => p.name === 'Beta')).toMatchObject({ language: 'micropython', boardId: 'rpi-pico', componentCount: 2, status: 'ok' });

    list = await t.call('project.setPinned', { root: a.root, pinned: true });
    expect(list[0]).toMatchObject({ name: 'Alpha', pinned: true });

    const renamed = await t.call('project.rename', { root: a.root, name: 'Alpha Prime' });
    expect(renamed.name).toBe('Alpha Prime');

    const copy = await t.call('project.duplicate', { root: a.root, name: 'Alpha Copy' });
    expect(copy.name).toBe('Alpha Copy');
    expect(copy.id).not.toBe(renamed.id);
    expect(existsSync(join(copy.root, 'src/main.cpp'))).toBe(true);

    await t.call('project.delete', { root: copy.root });
    expect(existsSync(copy.root)).toBe(false);
    // Deleted projects are moved to a recoverable trash, never destroyed.
    const trash = join(t.dir, 'data', 'trash');
    expect(existsSync(trash)).toBe(true);
    expect((await t.call('project.list')).map((p) => p.name).sort()).toEqual(['Alpha Prime', 'Beta']);
  });

  it('refuses to delete folders that are not projects', async () => {
    const dir = join(t.dir, 'not-a-project');
    mkdirSync(dir);
    await expect(t.call('project.delete', { root: dir })).rejects.toMatchObject({ code: 'PROJECT_MANIFEST_MISSING' });
    expect(existsSync(dir)).toBe(true);
  });

  it('reports corrupted, missing and too-new project files clearly', async () => {
    const snap = await t.call('project.create', { name: 'Broken', boardId: 'arduino-uno-r3', language: 'arduino-cpp', template: 'blink' });
    await t.call('project.close');
    writeFileSync(join(snap.root, '.iotos/project.json'), '{ not json');
    await expect(t.call('project.open', { root: snap.root })).rejects.toMatchObject({ code: 'PROJECT_INVALID_JSON' });
    const list = await t.call('project.list');
    expect(list.find((p) => p.root === snap.root)).toMatchObject({ status: 'error' });

    const manifest = JSON.parse(readFileSync(join(t.dir, 'projects', 'broken', '.iotos', 'hardware.json'), 'utf8'));
    writeFileSync(join(snap.root, '.iotos/project.json'), JSON.stringify({ schemaVersion: 99 }));
    await expect(t.call('project.open', { root: snap.root })).rejects.toMatchObject({ code: 'PROJECT_VERSION_UNSUPPORTED' });
    expect(manifest.boardId).toBe('arduino-uno-r3');

    await expect(t.call('project.open', { root: join(t.dir, 'nowhere') })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('recovers from a missing circuit file with a warning', async () => {
    const snap = await t.call('project.create', { name: 'NoCircuit', boardId: 'arduino-uno-r3', language: 'arduino-cpp', template: 'empty' });
    await t.call('project.close');
    const { rmSync } = await import('node:fs');
    rmSync(join(snap.root, '.iotos/circuit.json'));
    const reopened = await t.call('project.open', { root: snap.root });
    expect(reopened.warnings[0]).toMatch(/circuit\.json was missing/);
    expect(reopened.circuit.components).toEqual([]);
  });

  it('saves the circuit model with validation', async () => {
    const snap = await t.call('project.create', { name: 'Save', boardId: 'esp32-devkit-v1', language: 'arduino-cpp', template: 'blink' });
    const circuit = { ...snap.circuit, components: snap.circuit.components.map((c) => (c.id === 'led1' ? { ...c, x: 999 } : c)) };
    const saved = await t.call('project.saveModel', { circuit });
    expect(saved.circuit.components.find((c) => c.id === 'led1')!.x).toBe(999);
    await expect(t.call('project.saveModel', { circuit: { ...circuit, components: [...circuit.components, circuit.components[0]!] } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('project filesystem', () => {
  it('reads, writes, creates, renames, searches and deletes files', async () => {
    await t.call('project.create', { name: 'Files', boardId: 'esp32-devkit-v1', language: 'arduino-cpp', template: 'blink' });
    const r = await t.call('fs.read', { path: 'src/main.cpp' });
    expect(r.content).toContain('LED1_PIN');
    const w = await t.call('fs.write', { path: 'src/main.cpp', content: r.content + '// edited\n', expectedMtimeMs: r.mtimeMs });
    expect(w.mtimeMs).toBeGreaterThanOrEqual(r.mtimeMs);
    await t.call('fs.create', { path: 'src/sensors/util.h', kind: 'file', content: '#pragma once\n' });
    await t.call('fs.rename', { from: 'src/sensors/util.h', to: 'src/util.h' });
    const hits = await t.call('fs.search', { query: 'digitalWrite' });
    expect(hits.length).toBe(2);
    expect(hits[0]).toMatchObject({ path: 'src/main.cpp', column: 3 });
    await t.call('fs.delete', { path: 'src/util.h' });
    await expect(t.call('fs.read', { path: 'src/util.h' })).rejects.toMatchObject({ code: 'FS_NOT_FOUND' });
  });

  it('detects external modification on save', async () => {
    const snap = await t.call('project.create', { name: 'Ext', boardId: 'esp32-devkit-v1', language: 'arduino-cpp', template: 'blink' });
    const r = await t.call('fs.read', { path: 'src/main.cpp' });
    await new Promise((res) => setTimeout(res, 20));
    writeFileSync(join(snap.root, 'src/main.cpp'), 'changed elsewhere');
    await expect(t.call('fs.write', { path: 'src/main.cpp', content: 'mine', expectedMtimeMs: r.mtimeMs - 1000 })).rejects.toMatchObject({ code: 'FS_EXISTS' });
  });

  it('rejects path traversal, absolute paths and symlink escapes', async () => {
    const snap = await t.call('project.create', { name: 'Sec', boardId: 'esp32-devkit-v1', language: 'arduino-cpp', template: 'blink' });
    await expect(t.call('fs.read', { path: '../../etc/passwd' })).rejects.toMatchObject({ code: 'FS_PATH_OUTSIDE_PROJECT' });
    await expect(t.call('fs.read', { path: '/etc/passwd' })).rejects.toMatchObject({ code: 'FS_PATH_OUTSIDE_PROJECT' });
    await expect(t.call('fs.write', { path: 'src/../../escape.txt', content: 'x' })).rejects.toMatchObject({ code: 'FS_PATH_OUTSIDE_PROJECT' });
    symlinkSync(t.dir, join(snap.root, 'link'));
    await expect(t.call('fs.write', { path: 'link/escape.txt', content: 'x' })).rejects.toMatchObject({ code: 'FS_PATH_OUTSIDE_PROJECT' });
    await expect(t.call('fs.write', { path: '.iotos/circuit.json', content: '{}' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(t.call('fs.delete', { path: '.iotos/project.json' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('API boundary', () => {
  it('rejects unknown methods and invalid arguments', async () => {
    expect(await t.api.call('shell.exec', { cmd: 'rm -rf /' })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_METHOD' } });
    expect(await t.api.call('__proto__', {})).toMatchObject({ ok: false, error: { code: 'UNKNOWN_METHOD' } });
    expect(await t.api.call('project.create', { name: '' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await t.api.call('fs.read', {})).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });

  it('only opens allowlisted https URLs', async () => {
    await expect(t.call('app.openExternal', { url: 'https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers' })).resolves.toBeNull();
    await expect(t.call('app.openExternal', { url: 'https://evil.example.com/' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(t.call('app.openExternal', { url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('never exposes API keys through settings', async () => {
    const s = await t.call('settings.setApiKey', { provider: 'anthropic', key: 'sk-ant-test-1234567890abcdef' });
    expect(s.ai.hasKey.anthropic).toBe(true);
    expect(JSON.stringify(s)).not.toContain('sk-ant-test');
    expect(JSON.stringify(await t.call('settings.get'))).not.toContain('sk-ant-test');
    // Keys never land in the plain settings file.
    await t.call('settings.update', { editor: { fontSize: 14 } });
    expect(readFileSync(join(t.dir, 'data', 'settings.json'), 'utf8')).not.toContain('sk-ant-test');
    // And are redacted from logs.
    expect(t.services.logger.redact('key=sk-ant-test-1234567890abcdef')).not.toContain('1234567890');
  });

  it('exports redacted diagnostics', async () => {
    await t.call('settings.setApiKey', { provider: 'openai', key: 'sk-proj-abcdefghijklmnopqrstuvwxyz' });
    t.services.logger.scope('test').warn('leaky message sk-proj-abcdefghijklmnopqrstuvwxyz');
    const { path } = await t.call('app.exportDiagnostics');
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('"tools"');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});
