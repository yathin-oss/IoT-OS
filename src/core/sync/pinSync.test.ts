import { describe, expect, it } from 'vitest';
import { buildGraph, derivePinMap } from '../circuit/graph';
import { reassignBoardPin } from '../circuit/operations';
import { buildProject } from '../project/factory';
import { getRegistry } from '../registry/registry';
import { templateSpec } from '../templates/templates';
import { checkFirmwareSync, expectedPinSymbols, extractDefinitions, generateConfigFile, resolvePinValue } from './pinSync';

const ctx = { id: 'sync-test-0001', now: '2026-01-01T00:00:00.000Z' };

describe('firmware/circuit pin sync', () => {
  const reg = getRegistry();
  const board = reg.requireBoard('esp32-devkit-v1');
  const project = buildProject(templateSpec('blink', 'Blink', board.id, 'arduino-cpp'), ctx);

  function symbolsFor(circuit = project.circuit) {
    const g = buildGraph(circuit, board.id);
    return expectedPinSymbols(g, derivePinMap(g), 'arduino-cpp');
  }

  it('generates a config header from the circuit', () => {
    const header = generateConfigFile('arduino-cpp', symbolsFor(), board);
    expect(header).toMatch(/#define LED1_PIN\s+25\s+\/\/ LED1\.A -> D25 \(via R1\)/);
    expect(header).toContain('#pragma once');
  });

  it('is in sync right after project creation', () => {
    const files = Object.entries(project.files).map(([path, content]) => ({ path, content }));
    const diags = checkFirmwareSync({ files, configFile: 'include/config.h', expected: symbolsFor(), board });
    expect(diags).toEqual([]);
  });

  it('detects drift when the LED is moved from GPIO25 to GPIO26 in the circuit', () => {
    // r1.1 is the board-side pin of the series resistor.
    const moved = reassignBoardPin(project.circuit, 'r1', '1', 'GPIO26');
    const files = Object.entries(project.files).map(([path, content]) => ({ path, content }));
    const diags = checkFirmwareSync({ files, configFile: 'include/config.h', expected: symbolsFor(moved), board });
    expect(diags).toEqual([
      expect.objectContaining({
        code: 'SYNC_PIN_MISMATCH',
        target: expect.objectContaining({ file: 'include/config.h', line: expect.any(Number) }),
      }),
    ]);
    expect(diags[0]!.message).toMatch(/LED1_PIN is 25.*GPIO26/);
    // Regenerating the config resolves the drift.
    const regenerated = generateConfigFile('arduino-cpp', symbolsFor(moved), board);
    const fixed = files.map((f) => (f.path === 'include/config.h' ? { ...f, content: regenerated } : f));
    expect(checkFirmwareSync({ files: fixed, configFile: 'include/config.h', expected: symbolsFor(moved), board })).toEqual([]);
  });

  it('detects hard-coded pins not present in the circuit', () => {
    const files = [
      { path: 'include/config.h', content: generateConfigFile('arduino-cpp', symbolsFor(), board) },
      { path: 'src/main.cpp', content: 'void setup(){ pinMode(27, OUTPUT); }' },
    ];
    expect(checkFirmwareSync({ files, configFile: 'include/config.h', expected: symbolsFor(), board }).map((d) => d.code)).toEqual(['SYNC_UNKNOWN_PIN_LITERAL']);
  });

  it('extracts C and Python constant definitions', () => {
    expect(extractDefinitions('a.h', '#define LED_PIN 25\nconst int BTN_PIN = 4;\nstatic constexpr uint8_t X = A0;').map((d) => [d.name, d.value])).toEqual([
      ['LED_PIN', '25'],
      ['BTN_PIN', '4'],
      ['X', 'A0'],
    ]);
    expect(extractDefinitions('c.py', 'LED_PIN = 25  # comment\nled = 3').map((d) => d.name)).toEqual(['LED_PIN']);
  });

  it('resolves symbolic pin values', () => {
    const uno = reg.requireBoard('arduino-uno-r3');
    expect(resolvePinValue('A0', uno)).toBe(14);
    expect(resolvePinValue('GPIO_NUM_25', board)).toBe(25);
    expect(resolvePinValue('LED_BUILTIN', uno)).toBeNull();
  });

  it('generates MicroPython config', () => {
    const mp = buildProject(templateSpec('blink', 'Blink', 'rpi-pico', 'micropython'), ctx);
    expect(mp.files['src/config.py']).toMatch(/^LED1_PIN = 15 {2}# LED1\.A -> GP15/m);
  });
});
