import type { BoardDefinition, BoardPin } from '../types';
import { DIGITAL, pin } from './helpers';

function gp(n: number, extra: Partial<Parameters<typeof pin>[2]> = {}): BoardPin {
  return pin(`GP${n}`, n, {
    aliases: [String(n), `GPIO${n}`, `D${n}`],
    caps: [...DIGITAL, 'pwm', 'interrupt', 'i2c', 'spi', 'uart'],
    ...extra,
  });
}

export const raspberryPiPico: BoardDefinition = {
  id: 'rpi-pico',
  name: 'Raspberry Pi Pico',
  vendor: 'Raspberry Pi',
  architecture: 'rp2040',
  mcu: 'RP2040 (dual Cortex-M0+)',
  clockMhz: 133,
  flashKb: 2048,
  sramKb: 264,
  logicVoltage: 3.3,
  fiveVoltTolerant: false,
  maxPinCurrentMa: 12,
  pinMux: 'flexible',
  wifi: false,
  bluetooth: false,
  pins: [
    gp(0, { notes: 'Default UART0 TX.' }),
    gp(1, { notes: 'Default UART0 RX.' }),
    ...[2, 3].map((n) => gp(n)),
    gp(4, { notes: 'Default I2C0 SDA.' }),
    gp(5, { notes: 'Default I2C0 SCL.' }),
    ...[6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => gp(n)),
    gp(16, { notes: 'Default SPI0 MISO (RX).' }),
    gp(17, { notes: 'Default SPI0 CS.' }),
    gp(18, { notes: 'Default SPI0 SCK.' }),
    gp(19, { notes: 'Default SPI0 MOSI (TX).' }),
    ...[20, 21, 22].map((n) => gp(n)),
    gp(25, { flags: ['onboard-led', 'internal'], notes: 'On-board LED; not on the header.' }),
    gp(26, { adc: [0, 0] }),
    gp(27, { adc: [0, 1] }),
    gp(28, { adc: [0, 2] }),
  ],
  power: [
    { id: '3V3', label: '3V3(OUT)', kind: 'power', voltage: 3.3, maxCurrentMa: 300, notes: 'On-board buck-boost output; keep load under ~300 mA.' },
    { id: 'VBUS', label: 'VBUS', kind: 'power', voltage: 5, maxCurrentMa: 500, notes: 'USB 5 V when connected over USB.' },
    { id: 'VSYS', label: 'VSYS', kind: 'power', voltage: 5, notes: 'System input (1.8-5.5 V).' },
    { id: 'GND', label: 'GND', kind: 'ground' },
    { id: 'RUN', label: 'RUN', kind: 'control', notes: 'Reset (active LOW).' },
    { id: '3V3_EN', label: '3V3_EN', kind: 'control' },
    { id: 'ADC_VREF', label: 'ADC_VREF', kind: 'control' },
  ],
  buses: [
    { kind: 'i2c', id: 'I2C0', pins: { sda: 'GP4', scl: 'GP5' }, isDefault: true, notes: 'I2C can be assigned to specific alternate pin pairs.' },
    { kind: 'spi', id: 'SPI0', pins: { miso: 'GP16', cs: 'GP17', sck: 'GP18', mosi: 'GP19' }, isDefault: true },
    { kind: 'uart', id: 'UART0', pins: { tx: 'GP0', rx: 'GP1' }, isDefault: true },
  ],
  headers: {
    left: ['GP0', 'GP1', 'GND', 'GP2', 'GP3', 'GP4', 'GP5', 'GND', 'GP6', 'GP7', 'GP8', 'GP9', 'GND', 'GP10', 'GP11', 'GP12', 'GP13', 'GND', 'GP14', 'GP15'],
    right: ['VBUS', 'VSYS', 'GND', '3V3_EN', '3V3', 'ADC_VREF', 'GP28', 'GND', 'GP27', 'GP26', 'RUN', 'GP22', 'GND', 'GP21', 'GP20', 'GP19', 'GP18', 'GND', 'GP17', 'GP16'],
  },
  languages: ['micropython', 'arduino-cpp'],
  toolchain: {
    arduino: {
      fqbn: 'rp2040:rp2040:rpipico',
      core: 'rp2040:rp2040',
      indexUrl: 'https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json',
    },
    micropython: { firmwareFlash: 'uf2', firmwareUrl: 'https://micropython.org/download/RPI_PICO/' },
  },
  usbIds: [
    { vid: '2E8A', pid: '0005', confidence: 'exact', note: 'RP2040 running MicroPython' },
    { vid: '2E8A', pid: '000A', confidence: 'exact', note: 'RP2040 running Arduino-Pico firmware' },
    { vid: '2E8A', pid: '0003', confidence: 'exact', note: 'RP2040 in BOOTSEL mode (USB mass storage)' },
  ],
  simulation: { mcuEmulator: null },
  support: { build: 'supported', flash: 'supported', simulate: 'unsupported' },
  references: ['https://datasheets.raspberrypi.com/pico/pico-datasheet.pdf'],
};
