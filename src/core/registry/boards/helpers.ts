import type { BoardPin, PinCapability, PinFlag } from '../types';

export const DIGITAL: PinCapability[] = ['digital-in', 'digital-out'];

interface PinOpts {
  label?: string;
  aliases?: string[];
  caps?: PinCapability[];
  adc?: [unit: number, channel: number];
  dac?: number;
  touch?: number;
  flags?: PinFlag[];
  notes?: string;
  arduinoSymbol?: string;
}

/** Builds a pin definition. Capabilities default to digital in/out + PWM + interrupt. */
export function pin(id: string, gpio: number, opts: PinOpts = {}): BoardPin {
  const caps = new Set<PinCapability>(opts.caps ?? [...DIGITAL, 'pwm', 'interrupt']);
  if (opts.adc) caps.add('adc');
  if (opts.dac !== undefined) caps.add('dac');
  if (opts.touch !== undefined) caps.add('touch');
  if (opts.flags?.includes('input-only')) {
    caps.delete('digital-out');
    caps.delete('pwm');
    caps.delete('dac');
  }
  if (opts.flags?.includes('analog-only')) {
    caps.delete('digital-in');
    caps.delete('digital-out');
    caps.delete('pwm');
    caps.delete('interrupt');
  }
  const p: BoardPin = { id, label: opts.label ?? id, gpio, capabilities: [...caps] };
  if (opts.aliases) p.aliases = opts.aliases;
  if (opts.adc) p.adc = { unit: opts.adc[0], channel: opts.adc[1] };
  if (opts.dac !== undefined) p.dac = { channel: opts.dac };
  if (opts.touch !== undefined) p.touch = opts.touch;
  if (opts.flags) p.flags = opts.flags;
  if (opts.notes) p.notes = opts.notes;
  if (opts.arduinoSymbol) p.arduinoSymbol = opts.arduinoSymbol;
  return p;
}

/** ESP-style GPIO: id GPIOn with aliases "n", "IOn", "Dn". */
export function espGpio(n: number, opts: PinOpts = {}): BoardPin {
  const aliases = [String(n), `IO${n}`, `D${n}`, `G${n}`, ...(opts.aliases ?? [])];
  return pin(`GPIO${n}`, n, { ...opts, aliases, caps: opts.caps ?? [...DIGITAL, 'pwm', 'interrupt', 'i2c', 'spi', 'uart'] });
}
