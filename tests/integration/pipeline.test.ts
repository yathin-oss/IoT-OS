import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockBinding } from '@serialport/binding-mock';
import { assemble } from 'avr8js/dist/esm/utils/assembler.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toIntelHex } from '../../src/core/sim/hex';
import { SimulationSession } from '../../src/core/sim/session';
import type { BuildResult, EventMap } from '../../src/core/ipc/contract';
import { testServices } from './helpers';

const BLINK_D9_ASM = `
ldi r16, 0x02
out 0x04, r16    ; DDRB1 (D9) output
out 0x05, r16    ; D9 HIGH
end:
rjmp end
`;

let t: ReturnType<typeof testServices>;
const env = { ...process.env };

beforeEach(() => {
  t = testServices({ fakeArduino: true });
  const hexFile = join(t.dir, 'blink.hex');
  writeFileSync(hexFile, toIntelHex(assemble(BLINK_D9_ASM).bytes));
  process.env['FAKE_ARDUINO_HEX'] = hexFile;
  process.env['FAKE_ARDUINO_LOG'] = join(t.dir, 'fake-cli.log');
  process.env['FAKE_ARDUINO_CORES'] = 'arduino:avr';
  process.env['FAKE_ARDUINO_LIBS'] = '';
  delete process.env['FAKE_UPLOAD_FAIL'];
});
afterEach(async () => {
  for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_')) delete process.env[k];
  Object.assign(process.env, env);
  await t.dispose();
});

function fakeCliCalls(): string[][] {
  return readFileSync(process.env['FAKE_ARDUINO_LOG']!, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
}

async function unoProject(template = 'blink') {
  return t.call('project.create', { name: 'Pipeline', boardId: 'arduino-uno-r3', language: 'arduino-cpp', template });
}

describe('toolchain detection (with arduino-cli test double)', () => {
  it('detects version and installed cores', async () => {
    const tools = await t.call('toolchain.status', { refresh: true });
    expect(tools.find((x) => x.id === 'arduino-cli')).toMatchObject({ state: 'installed', version: '1.2.2' });
    const cores = await t.call('toolchain.cores');
    expect(cores.find((c) => c.core === 'arduino:avr')?.installed).toBe('9.9.9');
    expect(cores.find((c) => c.core === 'esp32:esp32')?.installed).toBeNull();
  });

  it('reports a missing tool with an install hint', async () => {
    t.services.settings.update({ toolPaths: { 'arduino-cli': join(t.dir, 'does-not-exist') } });
    t.services.resolver.clearCache();
    const s = (await t.call('toolchain.status', { refresh: true })).find((x) => x.id === 'arduino-cli')!;
    expect(s.state).toBe('missing');
    expect(s.fix).toMatch(/arduino-cli/);
  });
});

describe('build pipeline', () => {
  it('stages the sketch, compiles and produces a firmware artifact', async () => {
    await unoProject();
    const progress: EventMap['build.progress'][] = [];
    t.services.bus.on('build.progress', (p) => progress.push(p));
    const r = await t.call('build.run');
    expect(r.status, r.message).toBe('succeeded');
    expect(r.fqbn).toBe('arduino:avr:uno');
    expect(r.steps.map((s) => [s.id, s.status])).toEqual([
      ['validate-project', 'ok'],
      ['validate-hardware', 'ok'],
      ['check-sync', 'ok'],
      ['resolve-dependencies', 'ok'],
      ['select-toolchain', 'ok'],
      ['compile', 'ok'],
      ['artifact', 'ok'],
    ]);
    expect(r.artifacts.map((a) => a.kind).sort()).toEqual(['elf', 'hex']);
    expect(r.size).toEqual({ programBytes: 924, programMax: 32256, dataBytes: 9, dataMax: 2048 });
    expect(progress.length).toBeGreaterThan(5);
    const compile = fakeCliCalls().find((c) => c[0] === 'compile')!;
    expect(compile).toEqual(expect.arrayContaining(['--fqbn', 'arduino:avr:uno', '--warnings', 'default']));
    expect(compile.at(-1)).toMatch(/\.iotos\/build\/sketch$/);
  });

  it('parses compiler errors back to project paths', async () => {
    const snap = await unoProject();
    const main = readFileSync(join(snap.root, 'src/main.cpp'), 'utf8');
    await t.call('fs.write', { path: 'src/main.cpp', content: main.replace('delay(500);', 'IOTOS_TEST_COMPILE_ERROR;') });
    const r = await t.call('build.run');
    expect(r.status).toBe('failed');
    expect(r.steps.find((s) => s.id === 'compile')!.status).toBe('failed');
    expect(r.steps.find((s) => s.id === 'artifact')!.status).toBe('skipped');
    const err = r.diagnostics.find((d) => d.source === 'compiler')!;
    expect(err).toMatchObject({ code: 'UNDECLARED_IDENTIFIER', severity: 'error', target: { file: 'src/main.cpp', column: 3 } });
    expect(err.target!.line).toBe(main.split('\n').findIndex((l) => l.includes('delay(500)')) + 1);
  });

  it('maps a missing header to the library that provides it', async () => {
    await unoProject();
    const main = (await t.call('fs.read', { path: 'src/main.cpp' })).content;
    await t.call('fs.write', { path: 'src/main.cpp', content: `#include <DHT.h>\n${main}` });
    const r = await t.call('build.run');
    const d = r.diagnostics.find((x) => x.code === 'MISSING_HEADER')!;
    expect(d.hint).toMatch(/DHT sensor library/);
  });

  it('fails dependency resolution when required libraries are missing', async () => {
    await t.call('project.create', { name: 'Plant', boardId: 'esp32-devkit-v1', language: 'arduino-cpp', template: 'plant-monitor' });
    process.env['FAKE_ARDUINO_CORES'] = 'esp32:esp32';
    const r = await t.call('build.run');
    expect(r.status).toBe('failed');
    expect(r.steps.find((s) => s.id === 'resolve-dependencies')!.status).toBe('failed');
    expect(r.diagnostics.filter((d) => d.code === 'LIBRARY_MISSING').map((d) => d.message)).toEqual(expect.arrayContaining(['Library "DHT sensor library" is not installed']));
    process.env['FAKE_ARDUINO_LIBS'] = 'DHT sensor library,Adafruit Unified Sensor,Adafruit SSD1306,Adafruit GFX Library';
    const ok = await t.call('build.run');
    expect(ok.status, ok.message).toBe('succeeded');
    expect(ok.fqbn).toBe('esp32:esp32:esp32doit-devkit-v1');
  });

  it('fails clearly when the board package is not installed', async () => {
    process.env['FAKE_ARDUINO_CORES'] = '';
    await unoProject();
    const r = await t.call('build.run');
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/arduino:avr is not installed/);
    expect(r.diagnostics.some((d) => d.code === 'CORE_MISSING')).toBe(true);
  });

  it('blocks builds of definitely-invalid hardware models', async () => {
    const snap = await unoProject();
    await t.call('project.saveModel', { circuit: { ...snap.circuit, wires: [...snap.circuit.wires, { id: 'wshort', from: { node: 'board', pin: '5V' }, to: { node: 'board', pin: 'GND' } }] } });
    const r = await t.call('build.run');
    expect(r.status).toBe('blocked');
    expect(r.steps.find((s) => s.id === 'compile')!.status).toBe('skipped');
  });

  it('provides the built firmware to the simulator, which executes it', async () => {
    const snap = await unoProject();
    await t.call('build.run');
    const fw = await t.call('build.firmwareHex');
    expect(fw?.stale).toBe(false);
    // The blink template on an Uno wires LED1 (via R1) to D9 — the test firmware drives D9 HIGH.
    const sim = new SimulationSession({ circuit: snap.circuit, hardware: snap.hardware, firmwareHex: fw!.hex });
    expect(sim.step(5).components['led1']).toMatchObject({ kind: 'led', on: true });
  });
});

describe('devices, flash and serial (MockBinding ports)', () => {
  beforeEach(() => {
    MockBinding.createPort('/dev/cu.usbmodem1101', { echo: false, record: true, vendorId: '2341', productId: '0043', manufacturer: 'Arduino (www.arduino.cc)' });
  });

  it('detects and identifies boards from VID/PID', async () => {
    const devices = await t.call('devices.refresh');
    expect(devices).toEqual([
      expect.objectContaining({ port: '/dev/cu.usbmodem1101', state: 'CONNECTED', vid: '2341', pid: '0043', usbChip: { family: 'arduino-native', chip: null }, candidates: [expect.objectContaining({ boardId: 'arduino-uno-r3', confidence: 'exact' })] }),
    ]);
  });

  it('reports disconnection', async () => {
    await t.call('devices.refresh');
    const events: EventMap['devices.changed'][] = [];
    t.services.bus.on('devices.changed', (d) => events.push(d));
    MockBinding.reset();
    const after = await t.call('devices.refresh');
    expect(after[0]).toMatchObject({ state: 'DISCONNECTED' });
    expect(events.length).toBe(1);
  });

  it('refuses to flash without a build, then uploads after building', async () => {
    await unoProject();
    await t.call('devices.refresh');
    const blocked = await t.call('flash.run', { port: '/dev/cu.usbmodem1101' });
    expect(blocked.status).toBe('blocked');
    expect(blocked.checks.find((c) => c.id === 'artifact')!.status).toBe('blocked');

    await t.call('build.run');
    const r = await t.call('flash.run', { port: '/dev/cu.usbmodem1101' });
    expect(r.status, r.message).toBe('succeeded');
    expect(r.method).toBe('arduino-cli upload');
    const upload = fakeCliCalls().find((c) => c[0] === 'upload')!;
    expect(upload).toEqual(expect.arrayContaining(['--port', '/dev/cu.usbmodem1101', '--fqbn', 'arduino:avr:uno']));
    // The project remembers the port for next time.
    expect((await t.call('project.current'))!.manifest.runtime.port).toBe('/dev/cu.usbmodem1101');
  });

  it('asks for confirmation when the device looks like a different board', async () => {
    await t.call('project.create', { name: 'Esp', boardId: 'esp32-devkit-v1', language: 'arduino-cpp', template: 'blink' });
    process.env['FAKE_ARDUINO_CORES'] = 'esp32:esp32';
    await t.call('build.run');
    const r = await t.call('flash.run', { port: '/dev/cu.usbmodem1101' });
    expect(r.status).toBe('needs-confirmation');
    expect(r.checks.find((c) => c.id === 'identity')).toMatchObject({ status: 'warning', confirmable: true });
    const ok = await t.call('flash.run', { port: '/dev/cu.usbmodem1101', confirmed: ['identity'] });
    expect(ok.status).toBe('succeeded');
  });

  it('blocks flashing to a disconnected port', async () => {
    await unoProject();
    await t.call('build.run');
    const r = await t.call('flash.run', { port: '/dev/cu.nothing' });
    expect(r.status).toBe('blocked');
    expect(r.checks.find((c) => c.id === 'port')!.message).toMatch(/not connected/);
  });

  it('classifies uploader failures', async () => {
    await unoProject();
    await t.call('build.run');
    process.env['FAKE_UPLOAD_FAIL'] = '1';
    const r = await t.call('flash.run', { port: '/dev/cu.usbmodem1101' });
    expect(r.status).toBe('failed');
    expect(r.failure).toMatchObject({ code: 'NO_SYNC' });
    expect(r.failure!.hint).toMatch(/bootloader/);
  });

  it('streams serial data in batches, writes commands, and pauses during upload', async () => {
    await unoProject();
    await t.call('devices.refresh');
    const batches: EventMap['serial.data'][] = [];
    t.services.bus.on('serial.data', (d) => batches.push(d));
    const st = await t.call('serial.open', { port: '/dev/cu.usbmodem1101', baud: 115200 });
    expect(st.open).toBe(true);
    expect((await t.call('devices.list'))[0]!.inUse).toBe(true);

    const binding = (t.services.serial as unknown as { port: { port: { emitData(d: string): void; recording: Buffer } } }).port.port;
    binding.emitData('temp:25.1 hum:40\r\ntemp:25.2 hum:41\r\npartial');
    await new Promise((r) => setTimeout(r, 120));
    const lines = batches.flatMap((b) => b.lines.map((l) => l.text));
    expect(lines).toEqual(['temp:25.1 hum:40', 'temp:25.2 hum:41']);
    expect(batches.at(-1)!.partial).toBe('partial');

    await t.call('serial.write', { data: 'led on', lineEnding: 'crlf' });
    expect(binding.recording.toString()).toBe('led on\r\n');
    expect((await t.call('serial.history')).map((l) => l.text)).toEqual(['temp:25.1 hum:40', 'temp:25.2 hum:41']);

    // Upload releases the port and reopens the monitor afterwards.
    await t.call('build.run');
    const r = await t.call('flash.run', { port: '/dev/cu.usbmodem1101' });
    expect(r.status).toBe('succeeded');
    expect((await t.call('serial.status')).open).toBe(true);

    await t.call('serial.close');
    expect((await t.call('serial.status')).open).toBe(false);
  });

  it('reports open failures for missing ports', async () => {
    await expect(t.call('serial.open', { port: '/dev/cu.missing', baud: 9600 })).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
    await expect(t.call('serial.write', { data: 'x', lineEnding: 'lf' })).rejects.toMatchObject({ code: 'SERIAL_NOT_OPEN' });
    await expect(t.call('serial.open', { port: '/dev/cu.usbmodem1101', baud: 3 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('drops excess lines visibly instead of freezing under high throughput', async () => {
    await t.call('serial.open', { port: '/dev/cu.usbmodem1101', baud: 921600 });
    const batches: EventMap['serial.data'][] = [];
    t.services.bus.on('serial.data', (d) => batches.push(d));
    const binding = (t.services.serial as unknown as { port: { port: { emitData(d: string): void } } }).port.port;
    const chunk = Array.from({ length: 1000 }, (_, i) => `sample ${i}`).join('\n') + '\n';
    for (let i = 0; i < 12; i++) binding.emitData(chunk);
    await new Promise((r) => setTimeout(r, 300));
    const all = batches.flatMap((b) => b.lines);
    expect(all.some((l) => l.text.includes('lines dropped'))).toBe(true);
    expect(t.services.serial.history.size).toBe(12000);
    await t.call('serial.close');
  });
});

describe('library resolution (arduino-cli test double)', () => {
  it('compares declared, required and installed libraries', async () => {
    await t.call('project.create', { name: 'Plant', boardId: 'esp32-devkit-v1', language: 'arduino-cpp', template: 'plant-monitor' });
    process.env['FAKE_ARDUINO_LIBS'] = 'DHT sensor library';
    const r = await t.call('libraries.resolve');
    expect(r.checked).toBe(true);
    expect(r.status.find((s) => s.name === 'DHT sensor library')!.state).toBe('version-mismatch');
    expect(r.status.find((s) => s.name === 'Adafruit SSD1306')!.state).toBe('missing');
    const search = await t.call('libraries.search', { ecosystem: 'arduino', query: 'dht' });
    expect(search[0]).toMatchObject({ name: 'DHT sensor library', compatibility: 'compatible' });
    const inst = await t.call('libraries.install', { ecosystem: 'arduino', name: 'Adafruit SSD1306', version: '2.5.13', addToProject: true });
    expect(inst.ok).toBe(true);
    expect(fakeCliCalls().some((c) => c[0] === 'lib' && c[1] === 'install' && c[2] === 'Adafruit SSD1306@2.5.13')).toBe(true);
  });
});

export type { BuildResult };
