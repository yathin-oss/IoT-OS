import { describe, expect, it } from 'vitest';
// Test-only: avr8js ships an AVR assembler we use to produce real machine code.
import { assemble } from 'avr8js/dist/esm/utils/assembler.js';
import { addComponent, connect } from '../circuit/operations';
import { emptyCircuit, type Circuit, type HardwareModel } from '../project/schema';
import { loadIntelHex, toIntelHex } from './hex';
import { SimulationSession } from './session';
import { boardSimulationMatrix } from './capabilities';

const UNO: HardwareModel = { schemaVersion: 1, boardId: 'arduino-uno-r3', features: { wifi: false, bluetooth: false }, powerSource: 'usb', notes: '' };

function hexOf(asm: string): string {
  const { bytes, errors } = assemble(asm);
  if (errors.length) throw new Error(errors.join('\n'));
  return toIntelHex(bytes);
}

function ledOnPin(pin: string, c: Circuit = emptyCircuit()): Circuit {
  c = addComponent(c, 'led', { x: 0, y: 0 }).circuit;
  c = addComponent(c, 'resistor', { x: 0, y: 0 }).circuit;
  c = connect(c, { node: 'board', pin }, { node: 'r1', pin: '1' }).circuit;
  c = connect(c, { node: 'r1', pin: '2' }, { node: 'led1', pin: 'A' }).circuit;
  return connect(c, { node: 'led1', pin: 'K' }, { node: 'board', pin: 'GND' }).circuit;
}

// I/O addresses (I/O space) and data-space addresses for the ATmega328P.
const SET_D13_HIGH = `
ldi r16, 0x20
out 0x04, r16    ; DDRB5 = output (D13)
out 0x05, r16    ; PORTB5 = HIGH
end:
rjmp end
`;

const BUTTON_TO_LED = `
ldi r16, 0x04
out 0x0B, r16    ; PORTD2 pull-up (D2 input)
ldi r16, 0x20
out 0x04, r16    ; DDRB5 output (D13)
loop:
sbis 0x09, 2     ; skip if PIND2 is HIGH (not pressed)
rjmp on
cbi 0x05, 5
rjmp loop
on:
sbi 0x05, 5
rjmp loop
`;

const SQUARE_WAVE_D13 = `
ldi r16, 0x20
out 0x04, r16
loop:
sbi 0x05, 5
nop
nop
cbi 0x05, 5
rjmp loop
`;

const SERIAL_HI = `
ldi r16, 0x08
sts 0xC1, r16    ; UCSR0B = TXEN0
ldi r16, 103
sts 0xC4, r16    ; UBRR0L = 103 (9600 baud @ 16 MHz)
ldi r17, 72      ; 'H'
sts 0xC6, r17
w1:
lds r18, 0xC0
sbrs r18, 5      ; UDRE0
rjmp w1
ldi r17, 105     ; 'i'
sts 0xC6, r17
w2:
lds r18, 0xC0
sbrs r18, 5
rjmp w2
ldi r17, 10
sts 0xC6, r17
end:
rjmp end
`;

const ADC_TO_SERIAL = `
ldi r16, 0x08
sts 0xC1, r16    ; TX enable
ldi r16, 103
sts 0xC4, r16
ldi r16, 0x60
sts 0x7C, r16    ; ADMUX: AVCC ref, left adjust, channel 0 (A0)
ldi r16, 0xC7
sts 0x7A, r16    ; ADCSRA: enable + start, prescaler 128
wait:
lds r16, 0x7A
sbrc r16, 6      ; ADSC still set?
rjmp wait
lds r17, 0x79    ; ADCH (8 MSBs)
sts 0xC6, r17
end:
rjmp end
`;

describe('Intel HEX', () => {
  it('round-trips and validates checksums', () => {
    const data = Uint8Array.from({ length: 40 }, (_, i) => i * 3);
    const hex = toIntelHex(data);
    const out = new Uint8Array(64);
    expect(loadIntelHex(hex, out)).toBe(40);
    expect(out.slice(0, 40)).toEqual(data);
    expect(() => loadIntelHex(hex.replace(':10000000', ':10000001'), out)).toThrow(/checksum/);
    expect(() => loadIntelHex(':00000001FF\n'.replace('FF', 'FE'), out)).toThrow();
  });
});

describe('AVR (ATmega328P) simulation', () => {
  it('runs firmware that drives an LED through a resistor', () => {
    const s = new SimulationSession({ circuit: ledOnPin('D13'), hardware: UNO, firmwareHex: hexOf(SET_D13_HIGH) });
    expect(s.mode).toBe('mcu');
    const snap = s.step(5);
    expect(snap.pins['D13']).toMatchObject({ mode: 'output', level: 1 });
    expect(snap.components['led1']).toEqual({ kind: 'led', on: true, brightness: 1 });
    expect(snap.errors).toEqual([]);
  });

  it('LED stays dark when wired to a pin the firmware does not drive', () => {
    const s = new SimulationSession({ circuit: ledOnPin('D12'), hardware: UNO, firmwareHex: hexOf(SET_D13_HIGH) });
    expect(s.step(5).components['led1']).toMatchObject({ on: false });
  });

  it('feeds button presses back into the firmware (pull-up input)', () => {
    let c = ledOnPin('D13');
    c = addComponent(c, 'push-button', { x: 0, y: 0 }).circuit;
    c = connect(c, { node: 'board', pin: 'D2' }, { node: 'btn1', pin: '1' }).circuit;
    c = connect(c, { node: 'btn1', pin: '2' }, { node: 'board', pin: 'GND' }).circuit;
    const s = new SimulationSession({ circuit: c, hardware: UNO, firmwareHex: hexOf(BUTTON_TO_LED) });
    expect(s.step(5).components['led1']).toMatchObject({ on: false });
    s.setStimulus('btn1', 'pressed', true);
    s.step(5);
    expect(s.step(5).components['led1']).toMatchObject({ on: true });
    s.setStimulus('btn1', 'pressed', false);
    s.step(5);
    expect(s.step(5).components['led1']).toMatchObject({ on: false });
  });

  it('measures PWM-like duty cycles', () => {
    const s = new SimulationSession({ circuit: ledOnPin('D13'), hardware: UNO, firmwareHex: hexOf(SQUARE_WAVE_D13) });
    const snap = s.step(2);
    const duty = snap.pins['D13']!.duty;
    // sbi(2) + nop(1) + nop(1) high = 4 cycles; cbi(2) + rjmp(2) low = 4 cycles -> ~50%.
    expect(duty).toBeGreaterThan(0.4);
    expect(duty).toBeLessThan(0.6);
    expect(snap.pins['D13']!.freqHz).toBeGreaterThan(1_000_000);
    expect((snap.components['led1'] as { brightness: number }).brightness).toBeCloseTo(duty, 5);
  });

  it('captures USART output', () => {
    const s = new SimulationSession({ circuit: emptyCircuit(), hardware: UNO, firmwareHex: hexOf(SERIAL_HI) });
    let out = '';
    s.onSerial((b) => (out += new TextDecoder().decode(b)));
    s.step(10);
    expect(out).toBe('Hi\n');
  });

  it('feeds potentiometer voltage to the ADC', () => {
    let c = emptyCircuit();
    c = addComponent(c, 'potentiometer', { x: 0, y: 0 }, { props: { position: 0.25 } }).circuit;
    c = connect(c, { node: 'board', pin: '5V' }, { node: 'pot1', pin: 'VCC' }).circuit;
    c = connect(c, { node: 'pot1', pin: 'GND' }, { node: 'board', pin: 'GND' }).circuit;
    c = connect(c, { node: 'pot1', pin: 'SIG' }, { node: 'board', pin: 'A0' }).circuit;
    const s = new SimulationSession({ circuit: c, hardware: UNO, firmwareHex: hexOf(ADC_TO_SERIAL) });
    const bytes: number[] = [];
    s.onSerial((b) => bytes.push(...b));
    const snap = s.step(10);
    expect(snap.components['pot1']).toEqual({ kind: 'analog', volts: 1.25 });
    // 1.25 V / 5 V * 1024 = 256 -> ADCH (left adjusted) = 64
    expect(bytes).toEqual([64]);
  });
});

describe('circuit-only simulation', () => {
  it('drives pins manually on boards without an MCU emulator', () => {
    const esp: HardwareModel = { ...UNO, boardId: 'esp32-devkit-v1' };
    const s = new SimulationSession({ circuit: ledOnPin('GPIO25'), hardware: esp });
    expect(s.mode).toBe('circuit-only');
    expect(s.step(16).components['led1']).toMatchObject({ on: false });
    s.setManualPin('GPIO25', 'high');
    expect(s.step(16).components['led1']).toMatchObject({ on: true, brightness: 1 });
    s.setManualPin('GPIO25', { pwmDuty: 0.3 });
    expect(s.step(16).components['led1']).toMatchObject({ on: true, brightness: 0.3 });
    expect(() => s.sendSerial('x')).toThrow(/MCU/);
  });

  it('reports short circuits between strong drivers', () => {
    let c = emptyCircuit();
    c = addComponent(c, 'push-button', { x: 0, y: 0 }).circuit;
    c = connect(c, { node: 'board', pin: '3V3' }, { node: 'btn1', pin: '1' }).circuit;
    c = connect(c, { node: 'btn1', pin: '2' }, { node: 'board', pin: 'GND' }).circuit;
    const s = new SimulationSession({ circuit: c, hardware: { ...UNO, boardId: 'esp32-devkit-v1' } });
    expect(s.step(16).errors).toEqual([]);
    s.setStimulus('btn1', 'pressed', true);
    expect(s.step(16).errors[0]).toMatch(/Short circuit/);
  });

  it('relay and analog sensor models', () => {
    let c = emptyCircuit();
    c = addComponent(c, 'relay-module', { x: 0, y: 0 }).circuit;
    c = addComponent(c, 'soil-moisture-capacitive', { x: 0, y: 0 }, { props: { moisture: 1 } }).circuit;
    c = connect(c, { node: 'board', pin: 'VIN' }, { node: 'relay1', pin: 'VCC' }).circuit;
    c = connect(c, { node: 'relay1', pin: 'GND' }, { node: 'board', pin: 'GND' }).circuit;
    c = connect(c, { node: 'relay1', pin: 'IN' }, { node: 'board', pin: 'GPIO26' }).circuit;
    c = connect(c, { node: 'board', pin: '3V3' }, { node: 'soil1', pin: 'VCC' }).circuit;
    c = connect(c, { node: 'soil1', pin: 'GND' }, { node: 'board', pin: 'GND' }).circuit;
    c = connect(c, { node: 'soil1', pin: 'AOUT' }, { node: 'board', pin: 'GPIO34' }).circuit;
    const s = new SimulationSession({ circuit: c, hardware: { ...UNO, boardId: 'esp32-devkit-v1' } });
    s.setManualPin('GPIO26', 'low');
    const snap = s.step(16);
    expect(snap.components['relay1']).toEqual({ kind: 'relay', energized: true });
    expect(snap.components['soil1']).toEqual({ kind: 'analog', volts: 1.2 });
    expect(snap.pins['GPIO34']!.inputVolts).toBe(1.2);
  });

  it('exposes a capability matrix', () => {
    const m = boardSimulationMatrix();
    expect(m.filter((x) => x.firmware).map((x) => x.boardId)).toEqual(['arduino-uno-r3', 'arduino-nano']);
  });
});
