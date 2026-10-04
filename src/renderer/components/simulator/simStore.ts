import { create } from 'zustand';
import type { SimSnapshot } from '../../../core/sim/types';
import type { PropValue } from '../../../core/project/schema';
import { getRegistry } from '../../../core/registry/registry';
import { call, errorMessage } from '../../api/client';
import { useCircuit } from '../../state/circuit';
import { useUi } from '../../state/ui';
import type { SimRequest, SimResponse } from './simWorker';

interface SimState {
  running: boolean;
  mode: 'mcu' | 'circuit-only' | null;
  snapshot: SimSnapshot | null;
  serial: string;
  error: string | null;
  firmwareInfo: string | null;
  speed: number;
  /** Live stimulus overrides (button presses, slider values) during the run. */
  stimuli: Record<string, Record<string, PropValue>>;
  start(): Promise<void>;
  stop(): void;
  setSpeed(s: number): void;
  stimulus(componentId: string, key: string, value: PropValue): void;
  drivePin(pin: string, state: 'high' | 'low' | 'input' | 'input-pullup' | { pwmDuty: number }): void;
  sendSerial(text: string): void;
}

let worker: Worker | null = null;

function send(m: SimRequest) {
  worker?.postMessage(m);
}

export const useSim = create<SimState>((set, get) => ({
  running: false,
  mode: null,
  snapshot: null,
  serial: '',
  error: null,
  firmwareInfo: null,
  speed: 1,
  stimuli: {},
  async start() {
    const { history, hardware } = useCircuit.getState();
    if (!history || !hardware) return;
    const board = getRegistry().getBoard(hardware.boardId);
    if (!board) return;
    let hex: string | undefined;
    let firmwareInfo: string | null = null;
    if (board.simulation.mcuEmulator) {
      try {
        const fw = await call('build.firmwareHex');
        if (fw) {
          hex = fw.hex;
          firmwareInfo = `Firmware built ${new Date(fw.builtAt).toLocaleTimeString()}${fw.stale ? ' — sources changed since; rebuild to simulate the latest code' : ''}`;
        } else firmwareInfo = 'No firmware build yet — build the project to run your code. Running circuit-only.';
      } catch (err) {
        firmwareInfo = `Could not load firmware: ${errorMessage(err)}`;
      }
    } else {
      firmwareInfo = `${board.name} has no MCU emulator: drive pins manually in the inspector to exercise the circuit.`;
    }
    worker?.terminate();
    worker = new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<SimResponse>) => {
      const m = e.data;
      if (m.type === 'snapshot') set({ snapshot: m.snapshot, mode: m.snapshot.mode });
      else if (m.type === 'serial') set((s) => ({ serial: (s.serial + m.text).slice(-20000) }));
      else if (m.type === 'error') {
        set({ error: m.message });
        useUi.getState().toast('error', `Simulator: ${m.message}`);
      } else if (m.type === 'stopped') set({ running: false });
    };
    worker.onerror = (e) => {
      set({ error: e.message, running: false });
    };
    set({ running: true, error: null, serial: '', snapshot: null, firmwareInfo, stimuli: {} });
    send({ type: 'start', circuit: history.present, hardware, ...(hex ? { hex } : {}), speed: get().speed });
  },
  stop() {
    send({ type: 'stop' });
    worker?.terminate();
    worker = null;
    set({ running: false, snapshot: null, mode: null });
  },
  setSpeed(speed) {
    set({ speed });
    send({ type: 'speed', speed });
  },
  stimulus(componentId, key, value) {
    set((s) => ({ stimuli: { ...s.stimuli, [componentId]: { ...(s.stimuli[componentId] ?? {}), [key]: value } } }));
    send({ type: 'stimulus', componentId, key, value });
  },
  drivePin(pin, state) {
    send({ type: 'pin', pin, state });
  },
  sendSerial(text) {
    send({ type: 'serial', text });
  },
}));
