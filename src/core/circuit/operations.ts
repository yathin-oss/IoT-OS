import { IotosError } from '../errors';
import { getRegistry, type HardwareRegistry } from '../registry/registry';
import { BOARD_NODE, type Circuit, type ComponentInstance, type Endpoint, type PropValue, type Wire } from '../project/schema';
import { endpointKey } from './graph';
import { snap } from './geometry';

/**
 * Pure, immutable circuit editing operations. Each returns a new Circuit; the
 * caller (UI store, AI proposal applier, tests) owns history.
 */

export function nextId(prefix: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  let n = 1;
  while (set.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export function defaultProps(type: string, registry: HardwareRegistry = getRegistry()): Record<string, PropValue> {
  const def = registry.requireComponent(type);
  return Object.fromEntries(def.props.map((p) => [p.key, p.default]));
}

export function addComponent(
  circuit: Circuit,
  type: string,
  at: { x: number; y: number },
  opts: { id?: string; label?: string; props?: Record<string, PropValue> } = {},
  registry: HardwareRegistry = getRegistry(),
): { circuit: Circuit; id: string } {
  const def = registry.requireComponent(type);
  const taken = circuit.components.map((c) => c.id);
  const id = opts.id ?? nextId(def.labelPrefix, taken);
  if (taken.includes(id) || id === BOARD_NODE) throw new IotosError('INVALID_ARGUMENT', `Component id "${id}" already exists`);
  const inst: ComponentInstance = {
    id,
    type,
    label: opts.label ?? id.toUpperCase(),
    props: { ...defaultProps(type, registry), ...(opts.props ?? {}) },
    x: snap(at.x),
    y: snap(at.y),
    rotation: 0,
  };
  return { circuit: { ...circuit, components: [...circuit.components, inst] }, id };
}

export function removeComponents(circuit: Circuit, ids: string[]): Circuit {
  const drop = new Set(ids);
  return {
    ...circuit,
    components: circuit.components.filter((c) => !drop.has(c.id)),
    wires: circuit.wires.filter((w) => !drop.has(w.from.node) && !drop.has(w.to.node)),
  };
}

function updateComponent(circuit: Circuit, id: string, fn: (c: ComponentInstance) => ComponentInstance): Circuit {
  let found = false;
  const components = circuit.components.map((c) => {
    if (c.id !== id) return c;
    found = true;
    return fn(c);
  });
  if (!found) throw new IotosError('INVALID_ARGUMENT', `No component "${id}"`);
  return { ...circuit, components };
}

export function moveComponent(circuit: Circuit, id: string, to: { x: number; y: number }): Circuit {
  if (id === BOARD_NODE) return { ...circuit, board: { x: snap(to.x), y: snap(to.y) } };
  return updateComponent(circuit, id, (c) => ({ ...c, x: snap(to.x), y: snap(to.y) }));
}

export function rotateComponent(circuit: Circuit, id: string, delta: 90 | -90 = 90): Circuit {
  return updateComponent(circuit, id, (c) => ({ ...c, rotation: (((c.rotation + delta) % 360) + 360) % 360 as ComponentInstance['rotation'] }));
}

export function setComponentProps(circuit: Circuit, id: string, props: Record<string, PropValue>, registry: HardwareRegistry = getRegistry()): Circuit {
  return updateComponent(circuit, id, (c) => {
    const def = registry.requireComponent(c.type);
    for (const [k, v] of Object.entries(props)) {
      const pd = def.props.find((p) => p.key === k);
      if (!pd) throw new IotosError('INVALID_ARGUMENT', `${def.name} has no property "${k}"`);
      if (pd.type === 'number' && typeof v !== 'number') throw new IotosError('INVALID_ARGUMENT', `${pd.label} must be a number`);
      if (pd.type === 'boolean' && typeof v !== 'boolean') throw new IotosError('INVALID_ARGUMENT', `${pd.label} must be true/false`);
      if (pd.type === 'enum' && !pd.options?.some((o) => String(o) === String(v))) {
        throw new IotosError('INVALID_ARGUMENT', `${pd.label} must be one of ${pd.options?.join(', ')}`);
      }
      if (typeof v === 'number' && ((pd.min !== undefined && v < pd.min) || (pd.max !== undefined && v > pd.max))) {
        throw new IotosError('INVALID_ARGUMENT', `${pd.label} must be between ${pd.min} and ${pd.max}`);
      }
    }
    return { ...c, props: { ...c.props, ...props } };
  });
}

export function renameComponent(circuit: Circuit, id: string, label: string): Circuit {
  const trimmed = label.trim();
  if (!trimmed) throw new IotosError('INVALID_ARGUMENT', 'Label cannot be empty');
  return updateComponent(circuit, id, (c) => ({ ...c, label: trimmed.slice(0, 40) }));
}

/** Duplicates components and the wires *between* them (not wires to outside parts). */
export function duplicateComponents(circuit: Circuit, ids: string[], offset = { x: 30, y: 30 }, registry: HardwareRegistry = getRegistry()): { circuit: Circuit; idMap: Record<string, string> } {
  const idMap: Record<string, string> = {};
  const taken = new Set(circuit.components.map((c) => c.id));
  const added: ComponentInstance[] = [];
  for (const id of ids) {
    const src = circuit.components.find((c) => c.id === id);
    if (!src) continue;
    const def = registry.requireComponent(src.type);
    const newId = nextId(def.labelPrefix, taken);
    taken.add(newId);
    idMap[id] = newId;
    added.push({ ...src, id: newId, label: newId.toUpperCase(), x: snap(src.x + offset.x), y: snap(src.y + offset.y), props: { ...src.props } });
  }
  const wireIds = new Set(circuit.wires.map((w) => w.id));
  const newWires: Wire[] = [];
  for (const w of circuit.wires) {
    const a = idMap[w.from.node];
    const b = idMap[w.to.node];
    if (a && b) {
      const wid = nextId('w', wireIds);
      wireIds.add(wid);
      newWires.push({ ...w, id: wid, from: { ...w.from, node: a }, to: { ...w.to, node: b }, points: undefined });
    }
  }
  return { circuit: { ...circuit, components: [...circuit.components, ...added], wires: [...circuit.wires, ...newWires] }, idMap };
}

export function connect(circuit: Circuit, from: Endpoint, to: Endpoint, opts: { id?: string; color?: string } = {}): { circuit: Circuit; id: string } {
  if (endpointKey(from) === endpointKey(to)) throw new IotosError('INVALID_ARGUMENT', 'Cannot connect a pin to itself');
  const dup = circuit.wires.find(
    (w) =>
      (endpointKey(w.from) === endpointKey(from) && endpointKey(w.to) === endpointKey(to)) ||
      (endpointKey(w.from) === endpointKey(to) && endpointKey(w.to) === endpointKey(from)),
  );
  if (dup) return { circuit, id: dup.id };
  const id = opts.id ?? nextId('w', circuit.wires.map((w) => w.id));
  const wire: Wire = { id, from, to, ...(opts.color ? { color: opts.color } : {}) };
  return { circuit: { ...circuit, wires: [...circuit.wires, wire] }, id };
}

export function disconnect(circuit: Circuit, wireIds: string[]): Circuit {
  const drop = new Set(wireIds);
  return { ...circuit, wires: circuit.wires.filter((w) => !drop.has(w.id)) };
}

/** Removes all wires attached to a given endpoint. */
export function disconnectEndpoint(circuit: Circuit, e: Endpoint): Circuit {
  const k = endpointKey(e);
  return { ...circuit, wires: circuit.wires.filter((w) => endpointKey(w.from) !== k && endpointKey(w.to) !== k) };
}

/**
 * Re-points a component pin from its current board pin to another board pin
 * ("edit pins" in the inspector). Only wires that go directly to the board move.
 */
export function reassignBoardPin(circuit: Circuit, componentId: string, componentPin: string, newBoardPin: string): Circuit {
  const self = `${componentId}:${componentPin}`;
  let changed = false;
  const wires = circuit.wires.map((w) => {
    if (endpointKey(w.from) === self && w.to.node === BOARD_NODE) {
      changed = true;
      return { ...w, to: { node: BOARD_NODE, pin: newBoardPin }, points: undefined };
    }
    if (endpointKey(w.to) === self && w.from.node === BOARD_NODE) {
      changed = true;
      return { ...w, from: { node: BOARD_NODE, pin: newBoardPin }, points: undefined };
    }
    return w;
  });
  if (changed) return { ...circuit, wires };
  return connect(circuit, { node: componentId, pin: componentPin }, { node: BOARD_NODE, pin: newBoardPin }).circuit;
}
