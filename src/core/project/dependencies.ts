import { getRegistry, type HardwareRegistry } from '../registry/registry';
import type { BoardDefinition, Language } from '../registry/types';
import type { Circuit, Dependency } from './schema';

/**
 * Libraries implied by the circuit's components for a given board and language.
 * Bundled libraries (shipped with the core) are excluded.
 */
export function requiredDependencies(circuit: Circuit, board: BoardDefinition, language: Language, registry: HardwareRegistry = getRegistry()): Dependency[] {
  const out = new Map<string, Dependency>();
  for (const inst of circuit.components) {
    const def = registry.getComponent(inst.type);
    if (!def) continue;
    if (language === 'arduino-cpp') {
      for (const lib of def.firmware.arduino?.libraries ?? []) {
        if (lib.bundled) continue;
        if (lib.architectures && !lib.architectures.includes(board.architecture)) continue;
        if (!out.has(`arduino:${lib.name}`)) out.set(`arduino:${lib.name}`, { ecosystem: 'arduino', name: lib.name, ...(lib.version ? { version: lib.version } : {}) });
      }
    } else {
      for (const pkg of def.firmware.micropython?.mip ?? []) {
        if (!out.has(`mip:${pkg}`)) out.set(`mip:${pkg}`, { ecosystem: 'micropython-mip', name: pkg });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Map a missing header (from a compiler error) to the library that provides it. */
export function libraryForHeader(header: string, board: BoardDefinition | undefined, registry: HardwareRegistry = getRegistry()): string | null {
  const base = header.split('/').pop()!;
  for (const def of registry.listComponents()) {
    for (const lib of def.firmware.arduino?.libraries ?? []) {
      if (!lib.headers?.includes(base)) continue;
      if (board && lib.architectures && !lib.architectures.includes(board.architecture)) continue;
      return lib.name;
    }
  }
  return null;
}

/** Merge declared and required dependencies, keeping declared versions. */
export function mergeDependencies(declared: Dependency[], required: Dependency[]): Dependency[] {
  const out = new Map(declared.map((d) => [`${d.ecosystem}:${d.name}`, d]));
  for (const r of required) if (!out.has(`${r.ecosystem}:${r.name}`)) out.set(`${r.ecosystem}:${r.name}`, r);
  return [...out.values()];
}
