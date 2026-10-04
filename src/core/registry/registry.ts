import { IotosError } from '../errors';
import { arduinoNano, arduinoUnoR3, arduinoUnoR4Minima } from './boards/arduino';
import { esp32C3DevkitM1, esp32DevkitV1, esp32S3DevkitC1 } from './boards/esp32';
import { raspberryPiPico } from './boards/rp2040';
import { COMPONENTS } from './components';
import type { BoardDefinition, BoardPin, ComponentDefinition, ComponentPin, PowerPin } from './types';

/**
 * Registry of boards and components. Instances are immutable after construction;
 * the default registry contains the built-in definitions, and tests or future
 * plugins can construct a registry with additional definitions.
 */
export class HardwareRegistry {
  private readonly boards = new Map<string, BoardDefinition>();
  private readonly components = new Map<string, ComponentDefinition>();
  private readonly pinIndex = new Map<string, Map<string, BoardPin | PowerPin>>();

  constructor(boards: BoardDefinition[], components: ComponentDefinition[]) {
    for (const b of boards) this.addBoard(b);
    for (const c of components) {
      if (this.components.has(c.type)) throw new Error(`Duplicate component type "${c.type}"`);
      const pinIds = new Set<string>();
      for (const p of c.pins) {
        if (pinIds.has(p.id)) throw new Error(`Component "${c.type}" has duplicate pin "${p.id}"`);
        pinIds.add(p.id);
      }
      this.components.set(c.type, c);
    }
  }

  private addBoard(b: BoardDefinition): void {
    if (this.boards.has(b.id)) throw new Error(`Duplicate board id "${b.id}"`);
    const idx = new Map<string, BoardPin | PowerPin>();
    const claim = (key: string, p: BoardPin | PowerPin) => {
      const k = key.toUpperCase();
      const existing = idx.get(k);
      if (existing && existing !== p) throw new Error(`Board "${b.id}": pin name "${key}" is ambiguous (${existing.id} / ${p.id})`);
      idx.set(k, p);
    };
    for (const p of b.pins) {
      claim(p.id, p);
      for (const a of p.aliases ?? []) claim(a, p);
    }
    for (const p of b.power) claim(p.id, p);
    for (const side of [b.headers.left, b.headers.right]) {
      for (const id of side) {
        if (!idx.has(id.toUpperCase())) throw new Error(`Board "${b.id}": header references unknown pin "${id}"`);
      }
    }
    for (const bus of b.buses) {
      for (const pid of Object.values(bus.pins)) {
        if (!idx.has(pid.toUpperCase())) throw new Error(`Board "${b.id}": bus ${bus.id} references unknown pin "${pid}"`);
      }
    }
    this.boards.set(b.id, b);
    this.pinIndex.set(b.id, idx);
  }

  listBoards(): BoardDefinition[] {
    return [...this.boards.values()];
  }

  listComponents(): ComponentDefinition[] {
    return [...this.components.values()];
  }

  getBoard(id: string): BoardDefinition | undefined {
    return this.boards.get(id);
  }

  requireBoard(id: string): BoardDefinition {
    const b = this.boards.get(id);
    if (!b) throw new IotosError('BOARD_UNKNOWN', `Unknown board "${id}"`, { details: { boardId: id, known: [...this.boards.keys()] } });
    return b;
  }

  getComponent(type: string): ComponentDefinition | undefined {
    return this.components.get(type);
  }

  requireComponent(type: string): ComponentDefinition {
    const c = this.components.get(type);
    if (!c) throw new IotosError('COMPONENT_UNKNOWN', `Unknown component type "${type}"`, { details: { type } });
    return c;
  }

  /** Resolve a pin name or alias on a board (case-insensitive). */
  resolveBoardPin(boardId: string, name: string): BoardPin | PowerPin | undefined {
    return this.pinIndex.get(boardId)?.get(name.trim().toUpperCase());
  }

  getComponentPin(type: string, pinId: string): ComponentPin | undefined {
    return this.components.get(type)?.pins.find((p) => p.id === pinId);
  }
}

export function isGpio(p: BoardPin | PowerPin | undefined): p is BoardPin {
  return p !== undefined && 'gpio' in p;
}

export const BUILTIN_BOARDS: BoardDefinition[] = [
  esp32DevkitV1,
  esp32S3DevkitC1,
  esp32C3DevkitM1,
  arduinoUnoR3,
  arduinoUnoR4Minima,
  arduinoNano,
  raspberryPiPico,
];

let defaultRegistry: HardwareRegistry | null = null;

export function getRegistry(): HardwareRegistry {
  defaultRegistry ??= new HardwareRegistry(BUILTIN_BOARDS, COMPONENTS);
  return defaultRegistry;
}
