import type { CircuitGraph, Net } from '../circuit/graph';
import type { PropValue } from '../project/schema';
import type { BoardDefinition } from '../registry/types';
import type { ComponentSimState, McuPinState, NetSimState } from './types';

/**
 * Digital/analog circuit solver over the circuit graph.
 *
 * Model (documented in docs/SIMULATOR.md):
 *  - Nets are ideal conductors. Pressed buttons merge their two nets.
 *  - Strong drivers: supply rails, GND, MCU outputs, potentiometer wipers, analog
 *    sensor outputs, digital sensor outputs. Disagreeing strong drivers = short.
 *  - Weak drivers: MCU internal pull-ups; values propagated through series
 *    resistors into otherwise undriven nets (LED behind a resistor).
 *  - LEDs light when V(anode) − V(cathode) ≥ 75% of forward voltage; brightness
 *    follows the PWM duty of the driving pin.
 * This is a logic-level model, not SPICE: it does not compute currents.
 */

interface Drive {
  volts: number;
  duty: number | null;
  strength: 'strong' | 'weak';
  source: string;
}

export interface SolverInput {
  graph: CircuitGraph;
  board: BoardDefinition;
  /** Board pin id -> MCU pin state. */
  mcuPins: Map<string, McuPinState>;
  /** componentId -> effective props (instance props merged with live stimuli). */
  props: (componentId: string) => Record<string, PropValue>;
}

export interface SolverOutput {
  nets: NetSimState[];
  components: Record<string, ComponentSimState>;
  /** Board pin id -> voltage seen at the pin (null = floating). */
  pinVolts: Map<string, number | null>;
  errors: string[];
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function num(v: PropValue | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function solveCircuit(input: SolverInput): SolverOutput {
  const { graph, board, mcuPins } = input;
  const errors: string[] = [];
  const uf = new UnionFind();
  for (const n of graph.nets) uf.find(n.id);

  const netOfPin = (componentId: string, pin: string): Net | undefined => graph.netOf.get(`${componentId}:${pin}`);
  const groupOf = (componentId: string, pin: string): string | null => {
    const n = netOfPin(componentId, pin);
    return n ? uf.find(n.id) : null;
  };

  // 1. Pressed buttons merge their nets.
  for (const [id, def] of graph.defs) {
    if (def.sim.model !== 'button') continue;
    if (input.props(id)[def.sim.stimulus ?? 'pressed'] !== true) continue;
    const a = netOfPin(id, def.pins[0]!.id);
    const b = netOfPin(id, def.pins[1]!.id);
    if (a && b) uf.union(a.id, b.id);
  }

  // Group nets.
  const groups = new Map<string, Net[]>();
  for (const n of graph.nets) {
    const g = uf.find(n.id);
    groups.set(g, [...(groups.get(g) ?? []), n]);
  }

  const drives = new Map<string, Drive[]>();
  const addDrive = (group: string | null, d: Drive) => {
    if (!group) return;
    drives.set(group, [...(drives.get(group) ?? []), d]);
  };

  // 2. Board rails and MCU pins.
  for (const [g, nets] of groups) {
    for (const n of nets) {
      for (const p of n.powerPins) {
        if (p.kind === 'ground') addDrive(g, { volts: 0, duty: null, strength: 'strong', source: 'GND' });
        else if (p.kind === 'power' && p.voltage !== undefined && (p.maxCurrentMa ?? 1) > 0) addDrive(g, { volts: p.voltage, duty: null, strength: 'strong', source: p.label });
      }
      for (const bp of n.boardPins) {
        const st = mcuPins.get(bp.id);
        if (!st) continue;
        if (st.mode === 'output') {
          // PWM nets carry the peak voltage plus the duty cycle; consumers (LED brightness,
          // servo angle) use the duty, digital readers see the peak level.
          const pwm = st.duty > 0.001 && st.duty < 0.999;
          addDrive(g, { volts: pwm || st.level === 1 ? board.logicVoltage : 0, duty: pwm ? st.duty : st.level, strength: 'strong', source: bp.label });
        } else if (st.mode === 'input-pullup') {
          addDrive(g, { volts: board.logicVoltage, duty: null, strength: 'weak', source: `${bp.label} pull-up` });
        }
      }
    }
  }

  const resolve = (g: string | null): { volts: number | null; duty: number | null; driven: NetSimState['driven']; conflict: boolean } => {
    if (!g) return { volts: null, duty: null, driven: 'floating', conflict: false };
    const ds = drives.get(g) ?? [];
    const strong = ds.filter((d) => d.strength === 'strong');
    if (strong.length > 0) {
      const conflict = strong.some((d) => Math.abs(d.volts - strong[0]!.volts) > 0.5);
      return { volts: strong[0]!.volts, duty: strong[0]!.duty, driven: 'strong', conflict };
    }
    const weak = ds.filter((d) => d.strength === 'weak');
    if (weak.length > 0) return { volts: weak[0]!.volts, duty: weak[0]!.duty, driven: 'weak', conflict: false };
    return { volts: null, duty: null, driven: 'floating', conflict: false };
  };

  // 3. Component sources that depend on supply voltages (two passes for wiper/sensors).
  const supplyOf = (id: string): number | null => {
    const def = graph.defs.get(id)!;
    const pwr = def.pins.find((p) => p.role === 'power');
    const gnd = def.pins.find((p) => p.role === 'ground');
    const v = pwr ? resolve(groupOf(id, pwr.id)).volts : null;
    const gv = gnd ? resolve(groupOf(id, gnd.id)).volts : 0;
    return v !== null && gv === 0 ? v : null;
  };
  for (const [id, def] of graph.defs) {
    const props = input.props(id);
    const out = def.sim.outputPin;
    if (!out) continue;
    const supply = supplyOf(id);
    if (supply === null) continue;
    const g = groupOf(id, out);
    if (def.sim.model === 'potentiometer' || def.sim.model === 'analog-sensor') {
      const pd = def.props.find((p) => p.key === def.sim.stimulus);
      const raw = num(props[def.sim.stimulus ?? ''], 0.5);
      const t = pd?.min !== undefined && pd.max !== undefined && pd.max > pd.min ? (raw - pd.min) / (pd.max - pd.min) : raw;
      const [lo, hi] = def.sim.outputRange === 'supply' || !def.sim.outputRange ? [0, supply] : def.sim.outputRange;
      const volts = Math.min(supply, lo + (hi - lo) * Math.max(0, Math.min(1, t)));
      addDrive(g, { volts, duty: null, strength: 'strong', source: `${id}.${out}` });
    } else if (def.sim.model === 'digital-sensor') {
      const pin = def.pins.find((p) => p.id === out);
      const high = props[def.sim.stimulus ?? ''] === true;
      const level = typeof pin?.outputHigh === 'number' ? pin.outputHigh : supply;
      addDrive(g, { volts: high ? level : 0, duty: null, strength: 'strong', source: `${id}.${out}` });
    }
  }

  // 4. Weak propagation through series resistors into undriven nets.
  for (let iter = 0; iter < 8; iter++) {
    let changed = false;
    for (const [id, def] of graph.defs) {
      if (def.sim.model !== 'resistor') continue;
      const a = groupOf(id, def.pins[0]!.id);
      const b = groupOf(id, def.pins[1]!.id);
      if (!a || !b || a === b) continue;
      const ra = resolve(a);
      const rb = resolve(b);
      if (ra.driven !== 'floating' && rb.driven === 'floating') {
        addDrive(b, { volts: ra.volts!, duty: ra.duty, strength: 'weak', source: `via ${id}` });
        changed = true;
      } else if (rb.driven !== 'floating' && ra.driven === 'floating') {
        addDrive(a, { volts: rb.volts!, duty: rb.duty, strength: 'weak', source: `via ${id}` });
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 5. Net states.
  const nets: NetSimState[] = [];
  for (const [g, groupNets] of groups) {
    const r = resolve(g);
    if (r.conflict) {
      const srcs = (drives.get(g) ?? []).filter((d) => d.strength === 'strong').map((d) => `${d.source}=${d.volts}V`);
      errors.push(`Short circuit: ${srcs.join(' vs ')}`);
    }
    for (const n of groupNets) nets.push({ id: n.id, volts: r.volts, duty: r.duty, driven: r.driven, conflict: r.conflict });
  }

  // 6. Component outputs.
  const components: Record<string, ComponentSimState> = {};
  for (const [id, def] of graph.defs) {
    const props = input.props(id);
    const pinState = (pin: string) => resolve(groupOf(id, pin));
    switch (def.sim.model) {
      case 'led': {
        const a = pinState('A');
        const k = pinState('K');
        const vf = num(props['forwardVoltage'], 2);
        const on = a.volts !== null && k.volts !== null && a.volts - k.volts >= vf * 0.75;
        const brightness = on ? (a.duty !== null ? Math.max(0, Math.min(1, a.duty)) : 1) : 0;
        components[id] = { kind: 'led', on: on && brightness > 0.01, brightness };
        break;
      }
      case 'button':
        components[id] = { kind: 'button', pressed: props[def.sim.stimulus ?? 'pressed'] === true };
        break;
      case 'buzzer': {
        const sig = pinState('SIG');
        const gnd = pinState('GND');
        const bp = findMcuPin(graph, id, 'SIG');
        const st = bp ? mcuPins.get(bp) : undefined;
        const on = sig.volts !== null && gnd.volts === 0 && (sig.volts > board.logicVoltage / 2 || (st?.freqHz ?? 0) > 20);
        components[id] = { kind: 'buzzer', on, freqHz: on ? (st?.freqHz ?? 0) : 0 };
        break;
      }
      case 'servo': {
        const bp = findMcuPin(graph, id, 'SIG');
        const st = bp ? mcuPins.get(bp) : undefined;
        const supply = supplyOf(id);
        let angle: number | null = null;
        if (st && supply !== null && st.mode === 'output' && st.freqHz > 20 && st.pulseUs >= 400 && st.pulseUs <= 2600) {
          angle = Math.round(Math.max(0, Math.min(180, ((st.pulseUs - 544) / (2400 - 544)) * 180)));
        }
        components[id] = { kind: 'servo', angle };
        break;
      }
      case 'relay': {
        const inp = pinState('IN');
        const supply = supplyOf(id);
        const activeLow = props['activeLow'] !== false;
        const high = inp.volts !== null && inp.volts > 1.5;
        const energized = supply !== null && inp.volts !== null && (activeLow ? !high : high);
        components[id] = { kind: 'relay', energized };
        break;
      }
      case 'potentiometer':
      case 'analog-sensor': {
        const out = def.sim.outputPin ? pinState(def.sim.outputPin).volts : null;
        components[id] = { kind: 'analog', volts: out ?? 0 };
        break;
      }
      case 'digital-sensor': {
        const out = def.sim.outputPin ? pinState(def.sim.outputPin).volts : null;
        components[id] = { kind: 'digital', high: (out ?? 0) > 1.5 };
        break;
      }
      case 'resistor':
        break;
      default:
        components[id] = { kind: 'unsupported', reason: def.sim.notes ?? `${def.name} is not simulated` };
    }
  }

  // 7. Voltage seen by each board GPIO.
  const pinVolts = new Map<string, number | null>();
  for (const [g, groupNets] of groups) {
    const r = resolve(g);
    for (const n of groupNets) for (const bp of n.boardPins) pinVolts.set(bp.id, r.volts);
  }
  return { nets, components, pinVolts, errors: [...new Set(errors)] };
}

/** Board pin directly wired (same net) to a component pin. */
function findMcuPin(graph: CircuitGraph, componentId: string, pin: string): string | null {
  const net = graph.netOf.get(`${componentId}:${pin}`);
  return net?.boardPins[0]?.id ?? null;
}
