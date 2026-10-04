/** Observed state of an MCU pin over the last simulation window. */
export interface McuPinState {
  mode: 'input' | 'input-pullup' | 'output';
  /** Instantaneous output level. */
  level: 0 | 1;
  /** Fraction of the window the pin was HIGH (PWM duty). */
  duty: number;
  /** Rising edges per second during the window. */
  freqHz: number;
  /** Width of the most recent HIGH pulse in microseconds (servo signals). */
  pulseUs: number;
}

/** Backend that executes firmware for a specific MCU. */
export interface McuRuntime {
  readonly frequency: number;
  run(ms: number): void;
  beginWindow(): void;
  /** Keyed by firmware GPIO number. */
  pinStates(): Map<number, McuPinState>;
  setDigitalInput(gpio: number, high: boolean): void;
  setAnalogInput(gpio: number, volts: number): void;
  takeSerialOutput(): Uint8Array;
  writeSerial(bytes: Uint8Array): void;
}

export type ComponentSimState =
  | { kind: 'led'; on: boolean; brightness: number }
  | { kind: 'buzzer'; on: boolean; freqHz: number }
  | { kind: 'servo'; angle: number | null }
  | { kind: 'relay'; energized: boolean }
  | { kind: 'button'; pressed: boolean }
  | { kind: 'analog'; volts: number }
  | { kind: 'digital'; high: boolean }
  | { kind: 'unsupported'; reason: string };

export interface NetSimState {
  id: string;
  volts: number | null;
  /** Fraction of time high, for PWM-driven nets. */
  duty: number | null;
  driven: 'strong' | 'weak' | 'floating';
  conflict: boolean;
}

export interface SimSnapshot {
  timeMs: number;
  mode: 'mcu' | 'circuit-only';
  components: Record<string, ComponentSimState>;
  /** Board pin id -> observed MCU pin state (mcu mode) or manual drive (circuit-only). */
  pins: Record<string, McuPinState & { inputVolts: number | null }>;
  nets: NetSimState[];
  /** Errors detected during simulation (e.g. shorts). */
  errors: string[];
  /** Simulation speed relative to real time over the last step (mcu mode). */
  speed: number | null;
}
