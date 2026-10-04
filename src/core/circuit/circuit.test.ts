import { describe, expect, it } from 'vitest';
import { emptyCircuit } from '../project/schema';
import { buildGraph, deriveBom, derivePinMap } from './graph';
import { createHistory, pushHistory, redo, undo } from './history';
import {
  addComponent,
  connect,
  disconnect,
  duplicateComponents,
  moveComponent,
  reassignBoardPin,
  removeComponents,
  rotateComponent,
  setComponentProps,
} from './operations';
import { boardGeometry, componentGeometry } from './geometry';
import { getRegistry } from '../registry/registry';

function ledCircuit() {
  let c = emptyCircuit();
  c = addComponent(c, 'led', { x: 300, y: 40 }).circuit;
  c = addComponent(c, 'resistor', { x: 200, y: 40 }).circuit;
  c = connect(c, { node: 'board', pin: 'GPIO25' }, { node: 'r1', pin: '1' }).circuit;
  c = connect(c, { node: 'r1', pin: '2' }, { node: 'led1', pin: 'A' }).circuit;
  c = connect(c, { node: 'led1', pin: 'K' }, { node: 'board', pin: 'GND' }).circuit;
  return c;
}

describe('circuit graph', () => {
  it('builds nets and resolves pin bindings through a series resistor', () => {
    const g = buildGraph(ledCircuit(), 'esp32-devkit-v1');
    const net = g.netOf.get('board:GPIO25')!;
    expect(net.endpoints.map((e) => e.key).sort()).toEqual(['board:GPIO25', 'r1:1']);
    expect(g.netOf.get('led1:K')!.hasGround).toBe(true);
    const map = derivePinMap(g);
    expect(map).toHaveLength(1);
    expect(map[0]).toMatchObject({ componentId: 'led1', componentPin: 'A', via: 'r1' });
  });

  it('joins board pin aliases into one net', () => {
    let c = emptyCircuit();
    c = addComponent(c, 'led', { x: 0, y: 0 }).circuit;
    c = addComponent(c, 'led', { x: 0, y: 0 }).circuit;
    c = connect(c, { node: 'board', pin: '25' }, { node: 'led1', pin: 'A' }).circuit;
    c = connect(c, { node: 'board', pin: 'GPIO25' }, { node: 'led2', pin: 'A' }).circuit;
    const g = buildGraph(c, 'esp32-devkit-v1');
    expect(g.netOf.get('led1:A')).toBe(g.netOf.get('led2:A'));
  });

  it('derives a bill of materials excluding layout aids', () => {
    let c = ledCircuit();
    c = addComponent(c, 'breadboard', { x: 0, y: 0 }).circuit;
    expect(deriveBom(c).map((l) => [l.type, l.quantity])).toEqual([
      ['led', 1],
      ['resistor', 1],
    ]);
  });
});

describe('circuit operations', () => {
  it('adds, moves, rotates, edits and removes components', () => {
    let c = ledCircuit();
    c = moveComponent(c, 'led1', { x: 503, y: 97 });
    expect(c.components.find((x) => x.id === 'led1')).toMatchObject({ x: 500, y: 100 });
    c = rotateComponent(c, 'led1');
    c = rotateComponent(c, 'led1', -90);
    c = rotateComponent(c, 'led1', -90);
    expect(c.components.find((x) => x.id === 'led1')!.rotation).toBe(270);
    c = setComponentProps(c, 'led1', { color: 'blue' });
    expect(c.components.find((x) => x.id === 'led1')!.props['color']).toBe('blue');
    expect(() => setComponentProps(c, 'led1', { color: 'purple' })).toThrow(/one of/);
    expect(() => setComponentProps(c, 'led1', { nope: 1 })).toThrow(/no property/);
    c = removeComponents(c, ['led1']);
    expect(c.components.map((x) => x.id)).toEqual(['r1']);
    expect(c.wires.every((w) => w.from.node !== 'led1' && w.to.node !== 'led1')).toBe(true);
  });

  it('connects idempotently and disconnects', () => {
    let c = ledCircuit();
    const before = c.wires.length;
    const r = connect(c, { node: 'led1', pin: 'A' }, { node: 'r1', pin: '2' });
    expect(r.circuit.wires.length).toBe(before);
    expect(() => connect(c, { node: 'r1', pin: '1' }, { node: 'r1', pin: '1' })).toThrow();
    c = disconnect(c, [c.wires[0]!.id]);
    expect(c.wires.length).toBe(before - 1);
  });

  it('duplicates components with internal wires only', () => {
    const { circuit, idMap } = duplicateComponents(ledCircuit(), ['led1', 'r1']);
    expect(idMap).toEqual({ led1: 'led2', r1: 'r2' });
    const copies = circuit.wires.filter((w) => w.from.node === 'r2' || w.to.node === 'led2');
    expect(copies).toHaveLength(1);
  });

  it('reassigns a component pin to another board pin', () => {
    let c = emptyCircuit();
    c = addComponent(c, 'push-button', { x: 0, y: 0 }).circuit;
    c = reassignBoardPin(c, 'btn1', '1', 'GPIO27');
    c = reassignBoardPin(c, 'btn1', '1', 'GPIO26');
    expect(c.wires).toHaveLength(1);
    expect(c.wires[0]!.to).toEqual({ node: 'board', pin: 'GPIO26' });
  });

  it('undo/redo history', () => {
    let h = createHistory(ledCircuit());
    const moved = moveComponent(h.present, 'led1', { x: 0, y: 0 });
    h = pushHistory(h, moved);
    h = undo(h);
    expect(h.present.components.find((x) => x.id === 'led1')!.x).toBe(300);
    h = redo(h);
    expect(h.present).toBe(moved);
    expect(undo(undo(undo(h))).past).toEqual([]);
  });
});

describe('geometry', () => {
  it('places board header pins and rotates component pins', () => {
    const board = getRegistry().requireBoard('arduino-uno-r3');
    const g = boardGeometry(board, { x: 0, y: 0 });
    expect(g.pins.filter((p) => p.id === 'GND').length).toBe(2);
    const def = getRegistry().requireComponent('resistor');
    const inst = { id: 'r1', type: 'resistor', label: 'R1', props: {}, x: 0, y: 0, rotation: 90 as const };
    const geo = componentGeometry(inst, def);
    // 80x24 resistor rotated 90° about its centre (40,12): pins move to the vertical axis.
    expect(geo.pins.map((p) => [p.x, p.y])).toEqual([
      [40, -28],
      [40, 52],
    ]);
  });
});
