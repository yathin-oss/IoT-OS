import { buildGraph, derivePinMap } from '../circuit/graph';
import { autoLayout, wireColor } from '../circuit/layout';
import { generateHardwareDoc, generateSetupDoc } from '../docs/hardwareDocs';
import { IotosError } from '../errors';
import { getRegistry, isGpio, type HardwareRegistry } from '../registry/registry';
import type { Language } from '../registry/types';
import { expectedPinSymbols, generateConfigFile } from '../sync/pinSync';
import { validateHardware } from '../validation/engine';
import type { Diagnostic } from '../diagnostics';
import { mergeDependencies, requiredDependencies } from './dependencies';
import {
  BOARD_NODE,
  CURRENT_SCHEMA_VERSION,
  type Circuit,
  type ComponentInstance,
  type Dependency,
  type Endpoint,
  type HardwareModel,
  type ProjectManifest,
  type PropValue,
} from './schema';

/**
 * Structured project specification. Templates and the AI project builder both
 * produce a ProjectSpec; buildProject turns it into the on-disk model, so every
 * project — hand-made, templated or AI-generated — has the same shape.
 */
export interface ProjectSpec {
  name: string;
  description?: string;
  language: Language;
  boardId: string;
  features?: { wifi?: boolean; bluetooth?: boolean };
  components: { id: string; type: string; label?: string; props?: Record<string, PropValue> }[];
  connections: { from: Endpoint; to: Endpoint }[];
  /** Firmware source files, project-relative. The pin config file is generated and must not be included. */
  files: Record<string, string>;
  dependencies?: Dependency[];
  /** Optional extra documentation sections (e.g. AI-written overview). */
  docs?: { overview?: string };
  template?: string;
  tags?: string[];
}

export interface BuiltProject {
  manifest: ProjectManifest;
  hardware: HardwareModel;
  circuit: Circuit;
  files: Record<string, string>;
  diagnostics: Diagnostic[];
}

export function firmwarePaths(language: Language): { entry: string; configFile: string } {
  return language === 'micropython' ? { entry: 'src/main.py', configFile: 'src/config.py' } : { entry: 'src/main.cpp', configFile: 'include/config.h' };
}

export function buildProject(spec: ProjectSpec, ctx: { id: string; now: string }, registry: HardwareRegistry = getRegistry()): BuiltProject {
  const board = registry.requireBoard(spec.boardId);
  if (!board.languages.includes(spec.language)) {
    throw new IotosError('INVALID_ARGUMENT', `${board.name} does not support ${spec.language}`, { details: { supported: board.languages } });
  }
  const paths = firmwarePaths(spec.language);
  if (!spec.files[paths.entry]) throw new IotosError('INVALID_ARGUMENT', `Project spec is missing the firmware entry file ${paths.entry}`);
  if (paths.configFile in spec.files) {
    throw new IotosError('INVALID_ARGUMENT', `${paths.configFile} is generated from the circuit and must not be supplied`);
  }
  for (const p of Object.keys(spec.files)) {
    if (p.startsWith('/') || p.split('/').includes('..') || p.startsWith('.iotos')) throw new IotosError('INVALID_ARGUMENT', `Invalid file path in project spec: ${p}`);
  }

  const components: ComponentInstance[] = spec.components.map((c) => {
    const def = registry.requireComponent(c.type);
    return {
      id: c.id,
      type: c.type,
      label: (c.label ?? c.id).toUpperCase().slice(0, 40),
      props: { ...Object.fromEntries(def.props.map((p) => [p.key, p.default])), ...(c.props ?? {}) },
      x: 0,
      y: 0,
      rotation: 0,
    };
  });

  let signalIndex = 0;
  const wires = spec.connections.map((conn, i) => {
    const boardEnd = conn.from.node === BOARD_NODE ? conn.from : conn.to.node === BOARD_NODE ? conn.to : null;
    const bp = boardEnd ? registry.resolveBoardPin(board.id, boardEnd.pin) : undefined;
    const kind = bp && !isGpio(bp) ? (bp.kind === 'ground' ? 'ground' : 'power') : 'signal';
    // Canonicalize board pin aliases.
    const canon = (e: Endpoint): Endpoint => {
      if (e.node !== BOARD_NODE) return e;
      const p = registry.resolveBoardPin(board.id, e.pin);
      return p ? { node: BOARD_NODE, pin: p.id } : e;
    };
    return { id: `w${i + 1}`, from: canon(conn.from), to: canon(conn.to), color: wireColor(kind, kind === 'signal' ? signalIndex++ : 0) };
  });

  const circuit = autoLayout({ schemaVersion: CURRENT_SCHEMA_VERSION, board: { x: 0, y: 0 }, components, wires }, board, registry);
  const hardware: HardwareModel = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    boardId: board.id,
    features: { wifi: !!spec.features?.wifi, bluetooth: !!spec.features?.bluetooth },
    powerSource: 'usb',
    notes: '',
  };
  const validation = validateHardware(hardware, circuit, registry);
  const graph = buildGraph(circuit, board.id, registry);
  const symbols = expectedPinSymbols(graph, derivePinMap(graph), spec.language);
  const deps = mergeDependencies(spec.dependencies ?? [], requiredDependencies(circuit, board, spec.language, registry));

  const files: Record<string, string> = { ...spec.files };
  files[paths.configFile] = generateConfigFile(spec.language, symbols, board);
  const overview = spec.docs?.overview ? `${spec.docs.overview.trim()}\n\n` : '';
  files['docs/HARDWARE.md'] = overview + generateHardwareDoc(spec.name, circuit, hardware, validation.diagnostics, registry);
  files['docs/SETUP.md'] = generateSetupDoc(spec.name, board, spec.language, deps);
  files['.gitignore'] ??= '.iotos/build/\n';

  const manifest: ProjectManifest = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: ctx.id,
    name: spec.name.trim().slice(0, 80),
    description: spec.description ?? '',
    language: spec.language,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    firmware: paths,
    dependencies: deps,
    toolchain: { boardOptions: {} },
    runtime: { baud: 115200 },
    docs: ['docs/HARDWARE.md', 'docs/SETUP.md'],
    tags: spec.tags ?? [],
    ...(spec.template ? { template: spec.template } : {}),
  };
  return { manifest, hardware, circuit, files, diagnostics: validation.diagnostics };
}
