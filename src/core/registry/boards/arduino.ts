import type { BoardDefinition, BoardPin, PinCapability } from '../types';
import { DIGITAL, pin } from './helpers';

const PWM_PINS = new Set([3, 5, 6, 9, 10, 11]);

/** Digital pins D0-D13 for the Uno/Nano form factor. */
function unoDigitalPins(opts: { usbSerialOnD0D1: boolean; interruptPins: number[] }): BoardPin[] {
  const pins: BoardPin[] = [];
  for (let n = 0; n <= 13; n++) {
    const caps: PinCapability[] = [...DIGITAL];
    if (PWM_PINS.has(n)) caps.push('pwm');
    if (opts.interruptPins.includes(n)) caps.push('interrupt');
    if (n === 0 || n === 1) caps.push('uart');
    if (n >= 10) caps.push('spi');
    const notes: string[] = [];
    const flags: BoardPin['flags'] = [];
    if ((n === 0 || n === 1) && opts.usbSerialOnD0D1) {
      flags.push('usb-serial');
      notes.push(`Hardware Serial ${n === 0 ? 'RX' : 'TX'}, shared with USB: devices here interfere with upload and Serial Monitor.`);
    }
    if (n === 13) {
      flags.push('onboard-led');
      notes.push('Drives the on-board LED (LED_BUILTIN).');
    }
    if (n === 10) notes.push('SPI SS.');
    if (n === 11) notes.push('SPI MOSI.');
    if (n === 12) notes.push('SPI MISO.');
    if (n === 13) notes.push('SPI SCK.');
    const label = n === 0 ? 'D0/RX' : n === 1 ? 'D1/TX' : `D${n}`;
    pins.push(
      pin(`D${n}`, n, {
        label,
        aliases: [String(n), ...(n === 0 ? ['RX', 'RX0'] : n === 1 ? ['TX', 'TX0'] : [])],
        caps,
        ...(flags.length ? { flags } : {}),
        ...(notes.length ? { notes: notes.join(' ') } : {}),
      }),
    );
  }
  return pins;
}

/** Analog header A0-A5 (and A6/A7 on Nano). gpioBase is the Arduino number of A0. */
function analogPins(count: number, gpioBase: number, opts: { analogOnly?: number[]; dacOnA0?: boolean } = {}): BoardPin[] {
  const pins: BoardPin[] = [];
  for (let i = 0; i < count; i++) {
    const analogOnly = opts.analogOnly?.includes(i) ?? false;
    const caps: PinCapability[] = analogOnly ? [] : [...DIGITAL];
    if (i === 4 || i === 5) caps.push('i2c');
    const notes = analogOnly
      ? 'Analog input only: cannot be used with digitalRead/digitalWrite.'
      : i === 4
        ? 'I2C SDA.'
        : i === 5
          ? 'I2C SCL.'
          : undefined;
    pins.push(
      pin(`A${i}`, gpioBase + i, {
        aliases: [String(gpioBase + i), `D${gpioBase + i}`, ...(i === 4 ? ['SDA'] : i === 5 ? ['SCL'] : [])],
        caps,
        adc: [0, i],
        arduinoSymbol: `A${i}`,
        ...(opts.dacOnA0 && i === 0 ? { dac: 0 } : {}),
        ...(analogOnly ? { flags: ['analog-only' as const] } : {}),
        ...(notes ? { notes } : {}),
      }),
    );
  }
  return pins;
}

const AVR_BUSES: BoardDefinition['buses'] = [
  { kind: 'i2c', id: 'TWI', pins: { sda: 'A4', scl: 'A5' }, isDefault: true },
  { kind: 'spi', id: 'SPI', pins: { mosi: 'D11', miso: 'D12', sck: 'D13', cs: 'D10' }, isDefault: true },
  { kind: 'uart', id: 'Serial', pins: { tx: 'D1', rx: 'D0' }, isDefault: true },
];

const UNO_POWER: BoardDefinition['power'] = [
  { id: '5V', label: '5V', kind: 'power', voltage: 5, maxCurrentMa: 400, notes: 'From USB (500 mA polyfuse) or the on-board regulator.' },
  { id: '3V3', label: '3.3V', kind: 'power', voltage: 3.3, maxCurrentMa: 50, notes: 'Low-current 3.3 V regulator output (≈50 mA).' },
  { id: 'VIN', label: 'VIN', kind: 'power', voltage: 9, notes: 'External supply input (7-12 V recommended).' },
  { id: 'GND', label: 'GND', kind: 'ground' },
  { id: 'IOREF', label: 'IOREF', kind: 'power', voltage: 5, maxCurrentMa: 0, notes: 'Reference for shields; not a supply.' },
  { id: 'RESET', label: 'RESET', kind: 'control' },
  { id: 'AREF', label: 'AREF', kind: 'control', notes: 'Analog reference input.' },
];

export const arduinoUnoR3: BoardDefinition = {
  id: 'arduino-uno-r3',
  name: 'Arduino Uno R3',
  vendor: 'Arduino',
  architecture: 'avr',
  mcu: 'ATmega328P',
  clockMhz: 16,
  flashKb: 32,
  sramKb: 2,
  logicVoltage: 5,
  fiveVoltTolerant: true,
  maxPinCurrentMa: 20,
  pinMux: 'fixed',
  wifi: false,
  bluetooth: false,
  pins: [...unoDigitalPins({ usbSerialOnD0D1: true, interruptPins: [2, 3] }), ...analogPins(6, 14)],
  power: UNO_POWER,
  buses: AVR_BUSES,
  headers: {
    left: ['IOREF', 'RESET', '3V3', '5V', 'GND', 'VIN', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5'],
    right: ['AREF', 'GND', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0'],
  },
  languages: ['arduino-cpp'],
  toolchain: { arduino: { fqbn: 'arduino:avr:uno', core: 'arduino:avr' } },
  usbIds: [
    { vid: '2341', pid: '0043', confidence: 'exact', note: 'Arduino Uno R3 (ATmega16U2)' },
    { vid: '2341', pid: '0001', confidence: 'exact', note: 'Arduino Uno (ATmega8U2)' },
    { vid: '2A03', pid: '0043', confidence: 'exact', note: 'Arduino Uno R3 (arduino.org)' },
    { vid: '2341', pid: '0243', confidence: 'exact', note: 'Arduino Uno R3' },
    { vid: '1A86', pid: '7523', confidence: 'possible', note: 'CH340 bridge on Uno-compatible clones' },
  ],
  simulation: { mcuEmulator: 'avr8js-atmega328p' },
  support: { build: 'supported', flash: 'supported', simulate: 'supported' },
  references: [
    'https://docs.arduino.cc/hardware/uno-rev3',
    'https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf',
  ],
};

export const arduinoNano: BoardDefinition = {
  id: 'arduino-nano',
  name: 'Arduino Nano (ATmega328P)',
  vendor: 'Arduino',
  architecture: 'avr',
  mcu: 'ATmega328P',
  clockMhz: 16,
  flashKb: 32,
  sramKb: 2,
  logicVoltage: 5,
  fiveVoltTolerant: true,
  maxPinCurrentMa: 20,
  pinMux: 'fixed',
  wifi: false,
  bluetooth: false,
  pins: [...unoDigitalPins({ usbSerialOnD0D1: true, interruptPins: [2, 3] }), ...analogPins(8, 14, { analogOnly: [6, 7] })],
  power: [
    { id: '5V', label: '5V', kind: 'power', voltage: 5, maxCurrentMa: 400 },
    { id: '3V3', label: '3V3', kind: 'power', voltage: 3.3, maxCurrentMa: 50, notes: 'From the USB bridge (FT232) on originals; very limited current.' },
    { id: 'VIN', label: 'VIN', kind: 'power', voltage: 9 },
    { id: 'GND', label: 'GND', kind: 'ground' },
    { id: 'RESET', label: 'RST', kind: 'control' },
    { id: 'AREF', label: 'AREF', kind: 'control' },
  ],
  buses: AVR_BUSES,
  headers: {
    left: ['D13', '3V3', 'AREF', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', '5V', 'RESET', 'GND', 'VIN'],
    right: ['D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'GND', 'D0', 'D1'],
  },
  languages: ['arduino-cpp'],
  toolchain: { arduino: { fqbn: 'arduino:avr:nano:cpu=atmega328', core: 'arduino:avr' } },
  usbIds: [
    { vid: '0403', pid: '6001', confidence: 'likely', note: 'FTDI FT232R — original Arduino Nano' },
    { vid: '1A86', pid: '7523', confidence: 'possible', note: 'CH340 — Nano clones (may need cpu=atmega328old)' },
  ],
  simulation: { mcuEmulator: 'avr8js-atmega328p' },
  support: { build: 'supported', flash: 'supported', simulate: 'supported' },
  references: ['https://docs.arduino.cc/hardware/nano'],
};

export const arduinoUnoR4Minima: BoardDefinition = {
  id: 'arduino-uno-r4-minima',
  name: 'Arduino Uno R4 Minima',
  vendor: 'Arduino',
  architecture: 'renesas_uno',
  mcu: 'Renesas RA4M1 (Arm Cortex-M4)',
  clockMhz: 48,
  flashKb: 256,
  sramKb: 32,
  logicVoltage: 5,
  fiveVoltTolerant: true,
  maxPinCurrentMa: 8,
  pinMux: 'fixed',
  wifi: false,
  bluetooth: false,
  pins: [
    // On the R4 the USB connection is native, so D0/D1 (Serial1) are free.
    ...unoDigitalPins({ usbSerialOnD0D1: false, interruptPins: [2, 3] }),
    ...analogPins(6, 14, { dacOnA0: true }),
  ],
  power: UNO_POWER.map((p) => (p.id === '3V3' ? { ...p, maxCurrentMa: 100 } : p)),
  buses: [
    { kind: 'i2c', id: 'Wire', pins: { sda: 'A4', scl: 'A5' }, isDefault: true },
    { kind: 'spi', id: 'SPI', pins: { mosi: 'D11', miso: 'D12', sck: 'D13', cs: 'D10' }, isDefault: true },
    { kind: 'uart', id: 'Serial1', pins: { tx: 'D1', rx: 'D0' }, isDefault: true, notes: 'Serial (USB) is separate from Serial1.' },
  ],
  headers: arduinoUnoR3.headers,
  languages: ['arduino-cpp'],
  toolchain: { arduino: { fqbn: 'arduino:renesas_uno:minima', core: 'arduino:renesas_uno' } },
  usbIds: [
    { vid: '2341', pid: '0069', confidence: 'exact', note: 'Arduino Uno R4 Minima' },
    { vid: '2341', pid: '0369', confidence: 'exact', note: 'Arduino Uno R4 Minima (bootloader)' },
  ],
  simulation: { mcuEmulator: null },
  support: { build: 'supported', flash: 'untested', simulate: 'unsupported' },
  references: ['https://docs.arduino.cc/hardware/uno-r4-minima'],
};
