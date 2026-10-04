import { describe, expect, it } from 'vitest';
import { BUILTIN_BOARDS, HardwareRegistry, getRegistry, isGpio } from './registry';
import { COMPONENTS } from './components';
import { identifyUsbChip, normalizeHex } from './usbChips';

describe('hardware registry', () => {
  const reg = getRegistry();

  it('loads all built-in boards and components', () => {
    expect(reg.listBoards().map((b) => b.id)).toEqual([
      'esp32-devkit-v1',
      'esp32-s3-devkitc-1',
      'esp32-c3-devkitm-1',
      'arduino-uno-r3',
      'arduino-uno-r4-minima',
      'arduino-nano',
      'rpi-pico',
    ]);
    expect(reg.listComponents().length).toBeGreaterThanOrEqual(20);
  });

  it('resolves pins by id and alias, case-insensitively', () => {
    expect(reg.resolveBoardPin('esp32-devkit-v1', '25')?.id).toBe('GPIO25');
    expect(reg.resolveBoardPin('esp32-devkit-v1', 'd25')?.id).toBe('GPIO25');
    expect(reg.resolveBoardPin('esp32-devkit-v1', 'VP')?.id).toBe('GPIO36');
    expect(reg.resolveBoardPin('arduino-uno-r3', 'SDA')?.id).toBe('A4');
    expect(reg.resolveBoardPin('arduino-uno-r3', '13')?.id).toBe('D13');
    expect(reg.resolveBoardPin('rpi-pico', 'GPIO15')?.id).toBe('GP15');
    expect(reg.resolveBoardPin('arduino-uno-r3', 'GPIO99')).toBeUndefined();
  });

  it('encodes ESP32 input-only pins without output capabilities', () => {
    const p = reg.resolveBoardPin('esp32-devkit-v1', 'GPIO34');
    expect(isGpio(p)).toBe(true);
    if (!isGpio(p)) return;
    expect(p.flags).toContain('input-only');
    expect(p.capabilities).not.toContain('digital-out');
    expect(p.capabilities).not.toContain('pwm');
    expect(p.capabilities).toContain('adc');
  });

  it('encodes Nano A6/A7 as analog-only', () => {
    const p = reg.resolveBoardPin('arduino-nano', 'A6');
    expect(isGpio(p) && p.capabilities).toEqual(['adc']);
  });

  it('every header and bus reference resolves (validated at construction)', () => {
    expect(() => new HardwareRegistry(BUILTIN_BOARDS, COMPONENTS)).not.toThrow();
  });

  it('rejects duplicate definitions and dangling header pins', () => {
    const b = BUILTIN_BOARDS[0]!;
    expect(() => new HardwareRegistry([b, b], [])).toThrow(/Duplicate board/);
    expect(() => new HardwareRegistry([{ ...b, id: 'x', headers: { left: ['NOPE'], right: [] } }], [])).toThrow(/unknown pin/);
    expect(() => new HardwareRegistry([], [COMPONENTS[0]!, COMPONENTS[0]!])).toThrow(/Duplicate component/);
  });

  it('every board has a build toolchain and at least one language', () => {
    for (const b of reg.listBoards()) {
      expect(b.languages.length).toBeGreaterThan(0);
      if (b.languages.includes('arduino-cpp')) expect(b.toolchain.arduino?.fqbn).toMatch(/^[\w-]+:[\w-]+:[\w-]+/);
      if (b.languages.includes('micropython')) expect(b.toolchain.micropython).toBeDefined();
    }
  });

  it('every component signal pin requirement is a known capability', () => {
    for (const c of reg.listComponents()) {
      for (const p of c.pins) if (p.role === 'bus') expect(p.bus).toBeDefined();
      for (const s of c.firmware.symbols) expect(c.pins.some((p) => p.id === s.pin)).toBe(true);
    }
  });

  it('identifies USB bridge chips', () => {
    expect(identifyUsbChip('1A86', '7523')).toEqual({ family: 'ch34x', chip: 'CH340' });
    expect(identifyUsbChip('10C4', 'EA60').family).toBe('cp210x');
    expect(identifyUsbChip('2341', '9999').family).toBe('arduino-native');
    expect(identifyUsbChip(null, null).family).toBe('unknown');
    expect(normalizeHex('0x1a86')).toBe('1A86');
    expect(normalizeHex('ea60')).toBe('EA60');
    expect(normalizeHex('zz')).toBeNull();
  });
});
