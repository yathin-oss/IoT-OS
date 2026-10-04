import { describe, expect, it } from 'vitest';
import { connect, addComponent } from '../circuit/operations';
import { emptyCircuit, type Circuit, type HardwareModel } from '../project/schema';
import { validateHardware } from './engine';
import { blocksBuild, blocksFlash } from '../diagnostics';

function hw(boardId: string, wifi = false): HardwareModel {
  return { schemaVersion: 1, boardId, features: { wifi, bluetooth: false }, powerSource: 'usb', notes: '' };
}

/** Small DSL: parts + wires as "a.pin-b.pin" strings ("board.X" for board pins). */
function circuit(parts: [id: string, type: string, props?: Record<string, string | number | boolean>][], wires: string[]): Circuit {
  let c = emptyCircuit();
  for (const [id, type, props] of parts) c = addComponent(c, type, { x: 0, y: 0 }, { id, ...(props ? { props } : {}) }).circuit;
  for (const w of wires) {
    const [a, b] = w.split('-') as [string, string];
    const ep = (s: string) => {
      const [node, pin] = s.split('.') as [string, string];
      return { node, pin };
    };
    c = connect(c, ep(a), ep(b)).circuit;
  }
  return c;
}

const codes = (r: ReturnType<typeof validateHardware>) => r.diagnostics.map((d) => `${d.severity}:${d.code}`);

const ledOn = (pin: string) =>
  circuit(
    [
      ['led1', 'led'],
      ['r1', 'resistor'],
    ],
    [`board.${pin}-r1.1`, 'r1.2-led1.A', 'led1.K-board.GND'],
  );

describe('hardware validation', () => {
  it('accepts a correct LED circuit', () => {
    const r = validateHardware(hw('esp32-devkit-v1'), ledOn('GPIO25'));
    expect(r.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(r.pinMap).toEqual([expect.objectContaining({ componentId: 'led1', componentPin: 'A', via: 'r1', boardPin: expect.objectContaining({ id: 'GPIO25' }) })]);
  });

  it('rejects driving an LED from an ESP32 input-only pin', () => {
    const r = validateHardware(hw('esp32-devkit-v1'), ledOn('GPIO34'));
    expect(codes(r)).toContain('error:PIN_INPUT_ONLY');
    const d = r.diagnostics.find((x) => x.code === 'PIN_INPUT_ONLY')!;
    expect(d.hint).toMatch(/Free pins/);
    expect(blocksFlash(r.diagnostics)).toEqual({ blocked: true, overridable: true });
    expect(blocksBuild(r.diagnostics)).toBe(false);
  });

  it('warns about strapping pins and USB serial pins', () => {
    expect(codes(validateHardware(hw('esp32-devkit-v1'), ledOn('GPIO12')))).toContain('warning:PIN_STRAPPING');
    expect(codes(validateHardware(hw('arduino-uno-r3'), ledOn('D1')))).toContain('warning:PIN_USB_SERIAL');
  });

  it('accepts board pin aliases', () => {
    expect(validateHardware(hw('esp32-devkit-v1'), ledOn('25')).pinMap[0]?.boardPin.id).toBe('GPIO25');
  });

  it('flags pins that do not exist on the board', () => {
    expect(codes(validateHardware(hw('arduino-uno-r3'), ledOn('GPIO25')))).toContain('error:PIN_NOT_ON_BOARD');
  });

  it('flags ADC on a non-ADC pin and ADC2 with Wi-Fi', () => {
    const pot = (pin: string) =>
      circuit([['pot1', 'potentiometer']], ['board.3V3-pot1.VCC', 'pot1.GND-board.GND', `pot1.SIG-board.${pin}`]);
    expect(codes(validateHardware(hw('esp32-devkit-v1'), pot('GPIO23')))).toContain('error:PIN_NO_ADC');
    expect(codes(validateHardware(hw('esp32-devkit-v1', true), pot('GPIO26')))).toContain('error:PIN_ADC2_WIFI');
    expect(codes(validateHardware(hw('esp32-devkit-v1', false), pot('GPIO26')))).toContain('warning:PIN_ADC2_WIFI');
    expect(codes(validateHardware(hw('esp32-devkit-v1', true), pot('GPIO34')))).not.toContain('error:PIN_ADC2_WIFI');
    expect(codes(validateHardware(hw('arduino-nano'), pot('A6')))).not.toContain('error:PIN_NO_ADC');
  });

  it('detects 5 V outputs into a 3.3 V board (HC-SR04 ECHO on ESP32)', () => {
    const c = circuit(
      [['sonar1', 'hc-sr04']],
      ['board.VIN-sonar1.VCC', 'sonar1.GND-board.GND', 'sonar1.TRIG-board.GPIO5', 'sonar1.ECHO-board.GPIO18'],
    );
    const r = validateHardware(hw('esp32-devkit-v1'), c);
    const d = r.diagnostics.find((x) => x.code === 'LOGIC_OVERVOLTAGE');
    expect(d?.severity).toBe('error');
    expect(d?.hint).toMatch(/divider/);
    // The same sensor is fine on a 5 V Uno.
    const uno = circuit([['sonar1', 'hc-sr04']], ['board.5V-sonar1.VCC', 'sonar1.GND-board.GND', 'sonar1.TRIG-board.D9', 'sonar1.ECHO-board.D10']);
    expect(codes(validateHardware(hw('arduino-uno-r3'), uno)).filter((x) => x.startsWith('error'))).toEqual([]);
  });

  it('detects supply over- and under-voltage', () => {
    const nrf = circuit([['radio1', 'nrf24l01']], ['board.5V-radio1.VCC', 'radio1.GND-board.GND']);
    expect(codes(validateHardware(hw('arduino-uno-r3'), nrf))).toContain('error:SUPPLY_OVERVOLTAGE');
    const servo = circuit([['servo1', 'sg90-servo']], ['board.3V3-servo1.VCC', 'servo1.GND-board.GND', 'servo1.SIG-board.GPIO13']);
    expect(codes(validateHardware(hw('esp32-devkit-v1'), servo))).toContain('warning:SUPPLY_UNDERVOLTAGE');
  });

  it('blocks power shorts and rail conflicts', () => {
    const c: Circuit = { ...emptyCircuit(), wires: [{ id: 'w1', from: { node: 'board', pin: '3V3' }, to: { node: 'board', pin: 'GND' } }] };
    const r = validateHardware(hw('esp32-devkit-v1'), c);
    expect(codes(r)).toContain('blocking:NET_SHORT');
    expect(blocksBuild(r.diagnostics)).toBe(true);
    const rails: Circuit = { ...emptyCircuit(), wires: [{ id: 'w1', from: { node: 'board', pin: '3V3' }, to: { node: 'board', pin: '5V' } }] };
    expect(codes(validateHardware(hw('arduino-uno-r3'), rails))).toContain('blocking:NET_RAIL_CONFLICT');
  });

  it('enforces fixed I2C pins on AVR but only informs on flexible ESP32', () => {
    const oled = (sda: string, scl: string) =>
      circuit([['oled1', 'ssd1306-i2c']], ['board.5V-oled1.VCC', 'oled1.GND-board.GND', `oled1.SDA-board.${sda}`, `oled1.SCL-board.${scl}`]);
    expect(codes(validateHardware(hw('arduino-uno-r3'), oled('D4', 'D5')))).toContain('error:BUS_PIN_MISMATCH');
    expect(codes(validateHardware(hw('arduino-uno-r3'), oled('A4', 'A5'))).filter((x) => x.includes('BUS'))).toEqual([]);
    const esp = (sda: string, scl: string) =>
      circuit([['oled1', 'ssd1306-i2c']], ['board.3V3-oled1.VCC', 'oled1.GND-board.GND', `oled1.SDA-board.${sda}`, `oled1.SCL-board.${scl}`]);
    expect(codes(validateHardware(hw('esp32-devkit-v1'), esp('GPIO32', 'GPIO33')))).toContain('info:BUS_NON_DEFAULT_PINS');
  });

  it('detects I2C address conflicts on a shared bus', () => {
    const c = circuit(
      [
        ['oled1', 'ssd1306-i2c'],
        ['oled2', 'ssd1306-i2c'],
      ],
      ['oled1.SDA-board.A4', 'oled1.SCL-board.A5', 'oled2.SDA-board.A4', 'oled2.SCL-board.A5', 'board.5V-oled1.VCC', 'board.5V-oled2.VCC', 'oled1.GND-board.GND', 'oled2.GND-board.GND'],
    );
    expect(codes(validateHardware(hw('arduino-uno-r3'), c))).toContain('error:I2C_ADDRESS_CONFLICT');
  });

  it('warns about LEDs without series resistors', () => {
    const c = circuit([['led1', 'led']], ['board.GPIO25-led1.A', 'led1.K-board.GND']);
    expect(codes(validateHardware(hw('esp32-devkit-v1'), c))).toContain('warning:LED_NO_RESISTOR');
  });

  it('reports unknown boards and component types as blocking', () => {
    expect(codes(validateHardware(hw('no-such-board'), emptyCircuit()))).toEqual(['blocking:BOARD_UNKNOWN']);
    const c: Circuit = { ...emptyCircuit(), components: [{ id: 'x1', type: 'flux-capacitor', label: 'X1', props: {}, x: 0, y: 0, rotation: 0 }] };
    expect(codes(validateHardware(hw('arduino-uno-r3'), c))).toContain('blocking:COMPONENT_UNKNOWN');
  });

  it('flags Wi-Fi on boards without radios and rail overloads', () => {
    expect(codes(validateHardware(hw('arduino-uno-r3', true), emptyCircuit()))).toContain('error:FEATURE_UNSUPPORTED');
    const servos = circuit(
      [
        ['s1', 'sg90-servo'],
        ['s2', 'sg90-servo'],
      ],
      ['board.5V-s1.VCC', 'board.5V-s2.VCC', 's1.GND-board.GND', 's2.GND-board.GND', 's1.SIG-board.D9', 's2.SIG-board.D10'],
    );
    expect(codes(validateHardware(hw('arduino-uno-r3'), servos))).toContain('warning:RAIL_OVERLOAD');
  });

  it('reports unconnected required pins as warnings, not errors', () => {
    const c = circuit([['dht1', 'dht22']], ['dht1.DATA-board.GPIO4']);
    const r = validateHardware(hw('esp32-devkit-v1'), c);
    expect(codes(r)).toEqual(expect.arrayContaining(['warning:PIN_UNCONNECTED']));
    expect(blocksBuild(r.diagnostics)).toBe(false);
  });

  it('is deterministic', () => {
    const c = ledOn('GPIO12');
    expect(validateHardware(hw('esp32-devkit-v1'), c)).toEqual(validateHardware(hw('esp32-devkit-v1'), c));
  });
});
