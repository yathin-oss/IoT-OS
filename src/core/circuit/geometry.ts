import type { BoardDefinition, ComponentDefinition } from '../registry/types';
import type { ComponentInstance } from '../project/schema';

/**
 * Canvas geometry shared by the renderer, hit-testing and auto-layout so that
 * every consumer agrees on where pins are.
 */

export const PIN_PITCH = 20;
export const BOARD_WIDTH = 170;
const BOARD_PAD_TOP = 46;
const BOARD_PAD_BOTTOM = 20;

export interface Point {
  x: number;
  y: number;
}

export interface BoardGeometry {
  width: number;
  height: number;
  /** Header pin id -> list of positions (a pin id like GND may appear several times). */
  pins: { id: string; side: 'left' | 'right'; x: number; y: number; index: number }[];
}

export function boardGeometry(board: BoardDefinition, origin: Point): BoardGeometry {
  const rows = Math.max(board.headers.left.length, board.headers.right.length);
  const height = BOARD_PAD_TOP + rows * PIN_PITCH + BOARD_PAD_BOTTOM;
  const pins: BoardGeometry['pins'] = [];
  board.headers.left.forEach((id, i) => pins.push({ id, side: 'left', index: i, x: origin.x, y: origin.y + BOARD_PAD_TOP + i * PIN_PITCH + PIN_PITCH / 2 }));
  board.headers.right.forEach((id, i) =>
    pins.push({ id, side: 'right', index: i, x: origin.x + BOARD_WIDTH, y: origin.y + BOARD_PAD_TOP + i * PIN_PITCH + PIN_PITCH / 2 }),
  );
  return { width: BOARD_WIDTH, height, pins };
}

/** Position of a specific board pin, nearest to `near` when the pin appears multiple times. */
export function boardPinPosition(geom: BoardGeometry, pinId: string, near?: Point): Point | null {
  const candidates = geom.pins.filter((p) => p.id === pinId);
  if (candidates.length === 0) return null;
  if (!near || candidates.length === 1) return { x: candidates[0]!.x, y: candidates[0]!.y };
  let best = candidates[0]!;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = (c.x - near.x) ** 2 + (c.y - near.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return { x: best.x, y: best.y };
}

export interface ComponentGeometry {
  width: number;
  height: number;
  /** Pin positions in absolute canvas coordinates (rotation applied). */
  pins: { id: string; x: number; y: number }[];
}

function rotate(p: Point, center: Point, deg: number): Point {
  if (deg === 0) return p;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

/** Pins are laid out along the bottom edge (modules) or at the ends (two-terminal parts). */
export function componentGeometry(inst: ComponentInstance, def: ComponentDefinition): ComponentGeometry {
  const { width } = def.visual;
  const height = def.visual.height;
  const local: { id: string; x: number; y: number }[] = [];
  if (def.visual.shape === 'resistor') {
    local.push({ id: def.pins[0]!.id, x: 0, y: height / 2 });
    local.push({ id: def.pins[1]!.id, x: width, y: height / 2 });
  } else {
    const n = def.pins.length;
    const spacing = n > 0 ? width / (n + 1) : 0;
    def.pins.forEach((p, i) => local.push({ id: p.id, x: spacing * (i + 1), y: height }));
  }
  const center = { x: inst.x + width / 2, y: inst.y + height / 2 };
  return {
    width,
    height,
    pins: local.map((p) => ({ id: p.id, ...rotate({ x: inst.x + p.x, y: inst.y + p.y }, center, inst.rotation) })),
  };
}

export function snap(v: number, grid = 10): number {
  return Math.round(v / grid) * grid;
}
