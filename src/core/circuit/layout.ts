import { getRegistry, type HardwareRegistry } from '../registry/registry';
import type { BoardDefinition, BoardPin, PinCapability, PinFlag } from '../registry/types';
import type { Circuit } from '../project/schema';
import { boardGeometry, snap } from './geometry';

const AVOID: PinFlag[] = ['strapping', 'usb-serial', 'usb', 'flash', 'internal', 'psram', 'onboard-led'];

/**
 * Picks a free board pin that satisfies capabilities, preferring pins without
 * boot/USB restrictions. Deterministic: candidates are taken in header order.
 */
export function pickPin(board: BoardDefinition, caps: PinCapability[], used: Set<string>, opts: { avoidAdc2?: boolean; prefer?: string[] } = {}): BoardPin | null {
  const ok = (p: BoardPin) =>
    !used.has(p.id) &&
    caps.every((c) => p.capabilities.includes(c)) &&
    !(p.flags ?? []).some((f) => AVOID.includes(f)) &&
    !(opts.avoidAdc2 && caps.includes('adc') && (p.flags ?? []).includes('adc2-wifi'));
  for (const id of opts.prefer ?? []) {
    const p = board.pins.find((x) => x.id === id);
    if (p && ok(p)) return p;
  }
  const order = [...board.headers.left, ...board.headers.right];
  const inHeaders = order.map((id) => board.pins.find((p) => p.id === id)).filter((p): p is BoardPin => !!p);
  return inHeaders.find(ok) ?? null;
}

/** Places components in columns to the right of the board without overlap. */
export function autoLayout(circuit: Circuit, board: BoardDefinition, registry: HardwareRegistry = getRegistry()): Circuit {
  const geom = boardGeometry(board, circuit.board);
  const colX = [circuit.board.x + geom.width + 140, circuit.board.x + geom.width + 340, circuit.board.x + geom.width + 540];
  const colY = colX.map(() => circuit.board.y);
  const maxY = circuit.board.y + Math.max(geom.height, 500);
  let col = 0;
  const components = circuit.components.map((c) => {
    const def = registry.getComponent(c.type);
    const h = def?.visual.height ?? 60;
    if (colY[col]! + h > maxY && col < colX.length - 1) col++;
    const placed = { ...c, x: snap(colX[col]!), y: snap(colY[col]!) };
    colY[col] = colY[col]! + h + 50;
    return placed;
  });
  return { ...circuit, components };
}

export function wireColor(kind: 'power' | 'ground' | 'signal', index = 0): string {
  if (kind === 'power') return '#e5484d';
  if (kind === 'ground') return '#5b6170';
  const palette = ['#3e8ef7', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#e54666', '#0090ff', '#ad7f58'];
  return palette[index % palette.length]!;
}
