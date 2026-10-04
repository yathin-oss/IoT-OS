import {
  AVRADC,
  AVRIOPort,
  AVRTimer,
  AVRUSART,
  CPU,
  PinState,
  adcConfig,
  avrInstruction,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
} from 'avr8js';
import { loadIntelHex } from './hex';
import type { McuPinState, McuRuntime } from './types';

const FLASH_BYTES = 32 * 1024;
const FREQ_HZ = 16_000_000;

interface PinTrack {
  level: 0 | 1;
  lastChange: number;
  highCycles: number;
  rising: number;
  /** Width of the most recent completed high pulse, in cycles. */
  lastPulse: number;
}

/**
 * ATmega328P emulator (Arduino Uno R3 / Nano) built on avr8js. Executes the
 * actual compiled firmware (.hex from arduino-cli) cycle by cycle, including
 * timers (millis/delay/PWM), USART (Serial) and ADC (analogRead).
 *
 * Arduino pin numbering: D0-D7 = PORTD0-7, D8-D13 = PORTB0-5, A0-A5 (14-19) =
 * PORTC0-5, A6/A7 (20-21) = ADC channels 6/7 only.
 */
export class Atmega328pRuntime implements McuRuntime {
  readonly frequency = FREQ_HZ;
  private readonly cpu: CPU;
  private readonly ports: Record<'B' | 'C' | 'D', AVRIOPort>;
  private readonly adc: AVRADC;
  private readonly usart: AVRUSART;
  private readonly track = new Map<number, PinTrack>();
  private windowStart = 0;
  private serialOut: number[] = [];
  private rxQueue: number[] = [];

  constructor(hex: string) {
    const flash = new Uint8Array(FLASH_BYTES);
    loadIntelHex(hex, flash);
    this.cpu = new CPU(new Uint16Array(flash.buffer));
    // Peripherals register themselves with the CPU on construction.
    new AVRTimer(this.cpu, timer0Config);
    new AVRTimer(this.cpu, timer1Config);
    new AVRTimer(this.cpu, timer2Config);
    this.ports = {
      B: new AVRIOPort(this.cpu, portBConfig),
      C: new AVRIOPort(this.cpu, portCConfig),
      D: new AVRIOPort(this.cpu, portDConfig),
    };
    this.adc = new AVRADC(this.cpu, adcConfig);
    this.usart = new AVRUSART(this.cpu, usart0Config, FREQ_HZ);
    this.usart.onByteTransmit = (b) => this.serialOut.push(b);
    this.usart.onRxComplete = () => this.pumpRx();

    for (let gpio = 0; gpio <= 19; gpio++) this.track.set(gpio, { level: 0, lastChange: 0, highCycles: 0, rising: 0, lastPulse: 0 });
    const listen = (port: 'B' | 'C' | 'D', offset: number, count: number) => {
      this.ports[port].addListener((value, old) => {
        const changed = value ^ old;
        for (let bit = 0; bit < count; bit++) {
          if (!(changed & (1 << bit))) continue;
          this.onPinChange(offset + bit, (value >> bit) & 1 ? 1 : 0);
        }
      });
    };
    listen('D', 0, 8);
    listen('B', 8, 6);
    listen('C', 14, 6);
  }

  private onPinChange(gpio: number, level: 0 | 1): void {
    const t = this.track.get(gpio)!;
    const now = this.cpu.cycles;
    if (t.level === 1) {
      const start = Math.max(t.lastChange, this.windowStart);
      t.highCycles += now - start;
      t.lastPulse = now - t.lastChange;
    } else if (level === 1) t.rising++;
    t.level = level;
    t.lastChange = now;
  }

  private portOf(gpio: number): { port: AVRIOPort; bit: number } | null {
    if (gpio >= 0 && gpio <= 7) return { port: this.ports.D, bit: gpio };
    if (gpio >= 8 && gpio <= 13) return { port: this.ports.B, bit: gpio - 8 };
    if (gpio >= 14 && gpio <= 19) return { port: this.ports.C, bit: gpio - 14 };
    return null;
  }

  get cycles(): number {
    return this.cpu.cycles;
  }

  /** Execute for the given simulated duration. */
  run(ms: number): void {
    const target = this.cpu.cycles + Math.round((ms / 1000) * FREQ_HZ);
    while (this.cpu.cycles < target) {
      avrInstruction(this.cpu);
      this.cpu.tick();
    }
  }

  beginWindow(): void {
    this.windowStart = this.cpu.cycles;
    for (const t of this.track.values()) {
      t.highCycles = 0;
      t.rising = 0;
    }
  }

  pinStates(): Map<number, McuPinState> {
    const out = new Map<number, McuPinState>();
    const window = Math.max(1, this.cpu.cycles - this.windowStart);
    for (const [gpio, t] of this.track) {
      const loc = this.portOf(gpio)!;
      const st = loc.port.pinState(loc.bit);
      let high = t.highCycles;
      if (t.level === 1) high += this.cpu.cycles - Math.max(t.lastChange, this.windowStart);
      // A single transition inside the window is a level change, not PWM: report the
      // current level so a pin that just settled is not averaged into a fake duty cycle.
      const isPwm = t.rising >= 2;
      const duty = isPwm ? Math.min(1, high / window) : t.level;
      const freqHz = isPwm ? (t.rising * FREQ_HZ) / window : 0;
      const mode = st === PinState.Input ? 'input' : st === PinState.InputPullUp ? 'input-pullup' : 'output';
      out.set(gpio, {
        mode,
        level: st === PinState.High ? 1 : 0,
        duty: mode === 'output' ? duty : 0,
        freqHz: mode === 'output' ? freqHz : 0,
        pulseUs: (t.lastPulse / FREQ_HZ) * 1e6,
      });
    }
    return out;
  }

  setDigitalInput(gpio: number, high: boolean): void {
    const loc = this.portOf(gpio);
    if (loc) loc.port.setPin(loc.bit, high);
  }

  setAnalogInput(gpio: number, volts: number): void {
    const ch = gpio >= 14 && gpio <= 21 ? gpio - 14 : -1;
    if (ch >= 0) this.adc.channelValues[ch] = Math.max(0, Math.min(5, volts));
  }

  takeSerialOutput(): Uint8Array {
    const out = Uint8Array.from(this.serialOut);
    this.serialOut = [];
    return out;
  }

  writeSerial(bytes: Uint8Array): void {
    this.rxQueue.push(...bytes);
    this.pumpRx();
  }

  private pumpRx(): void {
    if (this.rxQueue.length === 0 || this.usart.rxBusy || !this.usart.rxEnable) return;
    this.usart.writeByte(this.rxQueue.shift()!);
  }

  get serialBaud(): number {
    return this.usart.baudRate;
  }
}
