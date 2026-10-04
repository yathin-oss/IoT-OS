import { buildGraph, type CircuitGraph } from '../circuit/graph';
import { IotosError } from '../errors';
import type { Circuit, HardwareModel, PropValue } from '../project/schema';
import { getRegistry, type HardwareRegistry } from '../registry/registry';
import type { BoardDefinition } from '../registry/types';
import { Atmega328pRuntime } from './avrRuntime';
import { solveCircuit } from './solver';
import type { McuPinState, McuRuntime, SimSnapshot } from './types';

/** Number of solver/MCU synchronisation slices per step. */
const SLICES = 4;

export interface SessionOptions {
  circuit: Circuit;
  hardware: HardwareModel;
  /** Intel HEX firmware; required for MCU mode. */
  firmwareHex?: string;
  registry?: HardwareRegistry;
  /** Injectable runtime factory (tests / future MCU backends). */
  runtimeFactory?: (board: BoardDefinition, hex: string) => McuRuntime;
}

export function createRuntime(board: BoardDefinition, hex: string): McuRuntime {
  switch (board.simulation.mcuEmulator) {
    case 'avr8js-atmega328p':
      return new Atmega328pRuntime(hex);
    default:
      throw new IotosError('BUILD_UNSUPPORTED', `${board.name} has no MCU emulator; only circuit-level simulation is available`);
  }
}

/**
 * One simulation run: binds a circuit to an MCU runtime (or manual pin drive in
 * circuit-only mode) and advances both in lock-step.
 */
export class SimulationSession {
  readonly mode: 'mcu' | 'circuit-only';
  readonly board: BoardDefinition;
  private readonly graph: CircuitGraph;
  private readonly circuit: Circuit;
  private readonly runtime: McuRuntime | null;
  private readonly stimuli = new Map<string, Record<string, PropValue>>();
  private readonly manualPins = new Map<string, McuPinState>();
  private timeMs = 0;
  private serialListener: ((bytes: Uint8Array) => void) | null = null;

  constructor(opts: SessionOptions) {
    const registry = opts.registry ?? getRegistry();
    this.board = registry.requireBoard(opts.hardware.boardId);
    this.circuit = opts.circuit;
    this.graph = buildGraph(opts.circuit, this.board.id, registry);
    if (opts.firmwareHex) {
      this.runtime = (opts.runtimeFactory ?? createRuntime)(this.board, opts.firmwareHex);
      this.mode = 'mcu';
    } else {
      this.runtime = null;
      this.mode = 'circuit-only';
    }
  }

  onSerial(fn: (bytes: Uint8Array) => void): void {
    this.serialListener = fn;
  }

  setStimulus(componentId: string, key: string, value: PropValue): void {
    if (!this.graph.instances.has(componentId)) throw new IotosError('INVALID_ARGUMENT', `No component ${componentId}`);
    this.stimuli.set(componentId, { ...(this.stimuli.get(componentId) ?? {}), [key]: value });
  }

  /** Circuit-only mode: drive a board pin manually. */
  setManualPin(boardPinId: string, state: 'high' | 'low' | 'input' | 'input-pullup' | { pwmDuty: number }): void {
    const pin = this.board.pins.find((p) => p.id === boardPinId);
    if (!pin) throw new IotosError('INVALID_ARGUMENT', `No pin ${boardPinId} on ${this.board.name}`);
    const base = { freqHz: 0, pulseUs: 0 };
    if (typeof state === 'object') this.manualPins.set(boardPinId, { mode: 'output', level: state.pwmDuty >= 0.5 ? 1 : 0, duty: state.pwmDuty, ...base, freqHz: 490 });
    else if (state === 'high' || state === 'low') this.manualPins.set(boardPinId, { mode: 'output', level: state === 'high' ? 1 : 0, duty: state === 'high' ? 1 : 0, ...base });
    else this.manualPins.set(boardPinId, { mode: state, level: 0, duty: 0, ...base });
  }

  sendSerial(text: string): void {
    if (!this.runtime) throw new IotosError('INVALID_ARGUMENT', 'Serial input requires MCU simulation');
    this.runtime.writeSerial(new TextEncoder().encode(text));
  }

  private props(id: string): Record<string, PropValue> {
    return { ...(this.graph.instances.get(id)?.props ?? {}), ...(this.stimuli.get(id) ?? {}) };
  }

  private mcuPinsByBoardId(): Map<string, McuPinState> {
    if (!this.runtime) return new Map(this.manualPins);
    const byGpio = this.runtime.pinStates();
    const out = new Map<string, McuPinState>();
    for (const p of this.board.pins) {
      const st = byGpio.get(p.gpio);
      if (st) out.set(p.id, st);
    }
    return out;
  }

  private applyInputs(pinVolts: Map<string, number | null>, mcuPins: Map<string, McuPinState>): void {
    if (!this.runtime) return;
    for (const p of this.board.pins) {
      const v = pinVolts.get(p.id);
      const st = mcuPins.get(p.id);
      if (p.capabilities.includes('adc')) this.runtime.setAnalogInput(p.gpio, v ?? 0);
      if (st && st.mode !== 'output') {
        // Floating inputs with pull-up read HIGH; without pull-up we model them as LOW.
        const high = v === null || v === undefined ? st.mode === 'input-pullup' : v > this.board.logicVoltage / 2;
        this.runtime.setDigitalInput(p.gpio, high);
      }
    }
  }

  /** Advance the simulation by `ms` of simulated time. */
  step(ms: number): SimSnapshot {
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let mcuPins = this.mcuPinsByBoardId();
    if (this.runtime) {
      this.runtime.beginWindow();
      for (let i = 0; i < SLICES; i++) {
        const pre = solveCircuit({ graph: this.graph, board: this.board, mcuPins: this.mcuPinsByBoardId(), props: (id) => this.props(id) });
        this.applyInputs(pre.pinVolts, this.mcuPinsByBoardId());
        this.runtime.run(ms / SLICES);
      }
      mcuPins = this.mcuPinsByBoardId();
      const out = this.runtime.takeSerialOutput();
      if (out.length && this.serialListener) this.serialListener(out);
    }
    this.timeMs += ms;
    const solved = solveCircuit({ graph: this.graph, board: this.board, mcuPins, props: (id) => this.props(id) });
    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
    const pins: SimSnapshot['pins'] = {};
    for (const [id, st] of mcuPins) pins[id] = { ...st, inputVolts: solved.pinVolts.get(id) ?? null };
    for (const [id, v] of solved.pinVolts) {
      if (!pins[id]) pins[id] = { mode: 'input', level: 0, duty: 0, freqHz: 0, pulseUs: 0, inputVolts: v };
    }
    return {
      timeMs: this.timeMs,
      mode: this.mode,
      components: solved.components,
      pins,
      nets: solved.nets,
      errors: solved.errors,
      speed: this.runtime && elapsed > 0 ? ms / elapsed : null,
    };
  }

  get circuitModel(): Circuit {
    return this.circuit;
  }
}
