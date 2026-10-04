/// <reference lib="webworker" />
import { SimulationSession } from '../../../core/sim/session';
import type { Circuit, HardwareModel, PropValue } from '../../../core/project/schema';

/**
 * Simulation worker: runs the MCU emulator + circuit solver off the UI thread,
 * paced to real time (scaled by `speed`), and streams snapshots + serial output.
 */
export type SimRequest =
  | { type: 'start'; circuit: Circuit; hardware: HardwareModel; hex?: string; speed: number }
  | { type: 'stop' }
  | { type: 'speed'; speed: number }
  | { type: 'stimulus'; componentId: string; key: string; value: PropValue }
  | { type: 'pin'; pin: string; state: 'high' | 'low' | 'input' | 'input-pullup' | { pwmDuty: number } }
  | { type: 'serial'; text: string };

export type SimResponse =
  | { type: 'snapshot'; snapshot: ReturnType<SimulationSession['step']> }
  | { type: 'serial'; text: string }
  | { type: 'error'; message: string }
  | { type: 'stopped' };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let session: SimulationSession | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let speed = 1;
const decoder = new TextDecoder();
const TICK_MS = 20;

function post(m: SimResponse) {
  ctx.postMessage(m);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  session = null;
}

ctx.onmessage = (e: MessageEvent<SimRequest>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'start': {
        stop();
        speed = m.speed;
        session = new SimulationSession({ circuit: m.circuit, hardware: m.hardware, ...(m.hex ? { firmwareHex: m.hex } : {}) });
        session.onSerial((bytes) => post({ type: 'serial', text: decoder.decode(bytes, { stream: true }) }));
        post({ type: 'snapshot', snapshot: session.step(0) });
        timer = setInterval(() => {
          if (!session) return;
          const t0 = performance.now();
          // Simulate TICK_MS * speed of device time; cap work per tick to keep the worker responsive.
          const snap = session.step(TICK_MS * speed);
          post({ type: 'snapshot', snapshot: snap });
          if (performance.now() - t0 > TICK_MS * 4) speed = Math.max(0.05, speed * 0.8);
        }, TICK_MS);
        break;
      }
      case 'stop':
        stop();
        post({ type: 'stopped' });
        break;
      case 'speed':
        speed = m.speed;
        break;
      case 'stimulus':
        session?.setStimulus(m.componentId, m.key, m.value);
        break;
      case 'pin':
        session?.setManualPin(m.pin, m.state);
        break;
      case 'serial':
        session?.sendSerial(m.text);
        break;
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
};
