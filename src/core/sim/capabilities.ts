import { getRegistry, type HardwareRegistry } from '../registry/registry';

export interface SimulationCapability {
  boardId: string;
  boardName: string;
  /** Firmware execution available. */
  firmware: boolean;
  backend: string;
  notes: string;
}

/** Board-level simulation capability matrix, derived from the registry. */
export function boardSimulationMatrix(registry: HardwareRegistry = getRegistry()): SimulationCapability[] {
  return registry.listBoards().map((b) => ({
    boardId: b.id,
    boardName: b.name,
    firmware: b.simulation.mcuEmulator !== null,
    backend: b.simulation.mcuEmulator ?? 'circuit-only',
    notes: b.simulation.mcuEmulator
      ? 'Runs the compiled firmware: GPIO, PWM, timers (millis/delay), ADC and Serial.'
      : 'No MCU emulator: pins can be driven manually to exercise the circuit; firmware is not executed.',
  }));
}

/** Component-level simulation support, derived from component definitions. */
export function componentSimulationMatrix(registry: HardwareRegistry = getRegistry()): { type: string; name: string; supported: boolean; notes: string }[] {
  return registry
    .listComponents()
    .filter((c) => c.electrical)
    .map((c) => ({ type: c.type, name: c.name, supported: c.sim.model !== 'none', notes: c.sim.notes ?? '' }));
}
