import { getRegistry, isGpio, type HardwareRegistry } from '../registry/registry';
import type { BoardDefinition, BoardPin, ComponentDefinition, ComponentPin, PowerPin } from '../registry/types';
import { BOARD_NODE, type Circuit, type ComponentInstance, type Endpoint } from '../project/schema';

/** An endpoint resolved against the registry. */
export type ResolvedEndpoint =
  | { kind: 'board-gpio'; key: string; endpoint: Endpoint; pin: BoardPin }
  | { kind: 'board-power'; key: string; endpoint: Endpoint; pin: PowerPin }
  | { kind: 'component'; key: string; endpoint: Endpoint; instance: ComponentInstance; def: ComponentDefinition; pin: ComponentPin }
  | { kind: 'invalid'; key: string; endpoint: Endpoint; reason: 'unknown-node' | 'unknown-type' | 'unknown-pin' };

export interface Net {
  id: string;
  endpoints: ResolvedEndpoint[];
  boardPins: BoardPin[];
  powerPins: PowerPin[];
  hasGround: boolean;
  /** Distinct supply voltages present on this net (from board power pins). */
  voltages: number[];
}

export interface CircuitGraph {
  board: BoardDefinition | undefined;
  /** endpoint key -> net */
  netOf: Map<string, Net>;
  nets: Net[];
  resolved: Map<string, ResolvedEndpoint>;
  instances: Map<string, ComponentInstance>;
  /** Component instance id -> definition (only for known types). */
  defs: Map<string, ComponentDefinition>;
}

export function endpointKey(e: Endpoint): string {
  return `${e.node}:${e.pin}`;
}

export function resolveEndpoint(
  e: Endpoint,
  board: BoardDefinition | undefined,
  instances: Map<string, ComponentInstance>,
  registry: HardwareRegistry,
): ResolvedEndpoint {
  if (e.node === BOARD_NODE) {
    if (!board) return { kind: 'invalid', key: endpointKey(e), endpoint: e, reason: 'unknown-node' };
    const p = registry.resolveBoardPin(board.id, e.pin);
    if (!p) return { kind: 'invalid', key: endpointKey(e), endpoint: e, reason: 'unknown-pin' };
    // Canonicalize aliases ("25" -> "GPIO25") so aliases join the same net.
    const canonical: Endpoint = { node: BOARD_NODE, pin: p.id };
    return isGpio(p)
      ? { kind: 'board-gpio', key: endpointKey(canonical), endpoint: canonical, pin: p }
      : { kind: 'board-power', key: endpointKey(canonical), endpoint: canonical, pin: p };
  }
  const inst = instances.get(e.node);
  if (!inst) return { kind: 'invalid', key: endpointKey(e), endpoint: e, reason: 'unknown-node' };
  const def = registry.getComponent(inst.type);
  if (!def) return { kind: 'invalid', key: endpointKey(e), endpoint: e, reason: 'unknown-type' };
  const pin = def.pins.find((p) => p.id === e.pin);
  if (!pin) return { kind: 'invalid', key: endpointKey(e), endpoint: e, reason: 'unknown-pin' };
  return { kind: 'component', key: endpointKey(e), endpoint: e, instance: inst, def, pin };
}

/** Builds electrical nets from wires using union-find. */
export function buildGraph(circuit: Circuit, boardId: string, registry: HardwareRegistry = getRegistry()): CircuitGraph {
  const board = registry.getBoard(boardId);
  const instances = new Map(circuit.components.map((c) => [c.id, c]));
  const resolved = new Map<string, ResolvedEndpoint>();
  const parent = new Map<string, string>();

  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // path compression
    let cur = k;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const add = (r: ResolvedEndpoint) => {
    if (!parent.has(r.key)) {
      parent.set(r.key, r.key);
      resolved.set(r.key, r);
    }
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const defs = new Map<string, ComponentDefinition>();
  // Every component pin participates even when unconnected (single-endpoint net).
  for (const inst of circuit.components) {
    const def = registry.getComponent(inst.type);
    if (!def) continue;
    defs.set(inst.id, def);
    for (const p of def.pins) add(resolveEndpoint({ node: inst.id, pin: p.id }, board, instances, registry));
  }
  for (const w of circuit.wires) {
    const a = resolveEndpoint(w.from, board, instances, registry);
    const b = resolveEndpoint(w.to, board, instances, registry);
    add(a);
    add(b);
    union(a.key, b.key);
  }

  const groups = new Map<string, ResolvedEndpoint[]>();
  for (const key of parent.keys()) {
    const root = find(key);
    const list = groups.get(root) ?? [];
    list.push(resolved.get(key)!);
    groups.set(root, list);
  }

  const nets: Net[] = [];
  const netOf = new Map<string, Net>();
  let i = 0;
  // Deterministic ordering: sort groups by their smallest key.
  const ordered = [...groups.values()].map((eps) => eps.sort((x, y) => x.key.localeCompare(y.key))).sort((x, y) => x[0]!.key.localeCompare(y[0]!.key));
  for (const eps of ordered) {
    const boardPins: BoardPin[] = [];
    const powerPins: PowerPin[] = [];
    for (const e of eps) {
      if (e.kind === 'board-gpio') boardPins.push(e.pin);
      if (e.kind === 'board-power') powerPins.push(e.pin);
    }
    const voltages = [...new Set(powerPins.filter((p) => p.kind === 'power' && p.voltage !== undefined).map((p) => p.voltage!))];
    const net: Net = {
      id: `N${++i}`,
      endpoints: eps,
      boardPins,
      powerPins,
      hasGround: powerPins.some((p) => p.kind === 'ground'),
      voltages,
    };
    nets.push(net);
    for (const e of eps) netOf.set(e.key, net);
  }
  return { board, netOf, nets, resolved, instances, defs };
}

export interface PinBinding {
  componentId: string;
  componentLabel: string;
  componentType: string;
  componentPin: string;
  boardPin: BoardPin;
  /** Passive component (e.g. series resistor) the signal passes through, if any. */
  via?: string;
}

/** Passive two-terminal parts a signal may traverse when resolving pin bindings. */
function isSeriesPassive(def: ComponentDefinition): boolean {
  return def.sim.model === 'resistor' && def.pins.length === 2;
}

/**
 * For a component pin, find the board GPIO it is wired to, either directly or
 * through one series passive (LED -> resistor -> GPIO).
 */
export function findBoardGpio(graph: CircuitGraph, componentId: string, pinId: string): { pin: BoardPin; via?: string } | null {
  const net = graph.netOf.get(`${componentId}:${pinId}`);
  if (!net) return null;
  if (net.boardPins.length > 0) return { pin: net.boardPins[0]! };
  for (const e of net.endpoints) {
    if (e.kind !== 'component' || e.instance.id === componentId || !isSeriesPassive(e.def)) continue;
    const other = e.def.pins.find((p) => p.id !== e.pin.id)!;
    const otherNet = graph.netOf.get(`${e.instance.id}:${other.id}`);
    if (otherNet && otherNet.boardPins.length > 0) return { pin: otherNet.boardPins[0]!, via: e.instance.id };
  }
  return null;
}

/** Derived pin map: every component signal/bus pin bound to a board GPIO. */
export function derivePinMap(graph: CircuitGraph): PinBinding[] {
  const out: PinBinding[] = [];
  for (const inst of graph.instances.values()) {
    const def = graph.defs.get(inst.id);
    if (!def || isSeriesPassive(def)) continue;
    for (const p of def.pins) {
      if (p.role === 'power' || p.role === 'ground') continue;
      const hit = findBoardGpio(graph, inst.id, p.id);
      if (!hit) continue;
      out.push({
        componentId: inst.id,
        componentLabel: inst.label,
        componentType: inst.type,
        componentPin: p.id,
        boardPin: hit.pin,
        ...(hit.via ? { via: hit.via } : {}),
      });
    }
  }
  return out.sort((a, b) => a.componentId.localeCompare(b.componentId) || a.componentPin.localeCompare(b.componentPin));
}

/** Supply voltage of a component instance, from the board rail its power pin connects to. */
export function componentSupplyVoltage(graph: CircuitGraph, inst: ComponentInstance, def: ComponentDefinition): number | null {
  for (const p of def.pins) {
    if (p.role !== 'power') continue;
    const net = graph.netOf.get(`${inst.id}:${p.id}`);
    if (net && net.voltages.length === 1) return net.voltages[0]!;
  }
  return null;
}

export interface BomLine {
  type: string;
  name: string;
  quantity: number;
  labels: string[];
}

/** Bill of materials derived from the circuit. */
export function deriveBom(circuit: Circuit, registry: HardwareRegistry = getRegistry()): BomLine[] {
  const byType = new Map<string, BomLine>();
  for (const c of circuit.components) {
    const def = registry.getComponent(c.type);
    if (def && !def.electrical) continue;
    const line = byType.get(c.type) ?? { type: c.type, name: def?.name ?? c.type, quantity: 0, labels: [] };
    line.quantity++;
    line.labels.push(c.label);
    byType.set(c.type, line);
  }
  return [...byType.values()].sort((a, b) => a.name.localeCompare(b.name));
}
