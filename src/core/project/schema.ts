import { z } from 'zod';
import { LANGUAGES } from '../registry/types';

/**
 * Versioned on-disk project format. See docs/PROJECT_FORMAT.md.
 *
 *   <project>/.iotos/project.json   manifest: metadata, language, dependencies, toolchain, runtime binding
 *   <project>/.iotos/hardware.json  target board + hardware-level settings
 *   <project>/.iotos/circuit.json   circuit graph: component instances + wires (the connectivity truth)
 *
 * The pin map and bill of materials are *derived* from circuit.json + the registry,
 * never stored twice.
 */

export const CURRENT_SCHEMA_VERSION = 1;

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO-8601 date');
const relPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(p) && !p.split(/[\\/]/).includes('..'), 'must be a project-relative path');

export const DEPENDENCY_ECOSYSTEMS = ['arduino', 'micropython-mip', 'platformio', 'pypi'] as const;

export const DependencySchema = z.object({
  ecosystem: z.enum(DEPENDENCY_ECOSYSTEMS),
  name: z.string().min(1).max(200),
  /** Exact version or omitted for "latest at install time". */
  version: z.string().max(50).optional(),
});
export type Dependency = z.infer<typeof DependencySchema>;

export const ProjectManifestSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  id: z.string().min(8),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000).default(''),
  language: z.enum(LANGUAGES),
  createdAt: isoDate,
  updatedAt: isoDate,
  firmware: z.object({
    /** Main firmware entry file. */
    entry: relPath,
    /** Generated pin configuration file (config.h / config.py). */
    configFile: relPath,
  }),
  dependencies: z.array(DependencySchema).default([]),
  toolchain: z
    .object({
      /** Board options appended to the FQBN, e.g. { cpu: "atmega328old" }. */
      boardOptions: z.record(z.string(), z.string()).default({}),
    })
    .default({ boardOptions: {} }),
  runtime: z
    .object({
      /** Last serial port used for this project. */
      port: z.string().max(300).optional(),
      baud: z.number().int().positive().default(115200),
    })
    .default({ baud: 115200 }),
  docs: z.array(relPath).default([]),
  tags: z.array(z.string().max(40)).max(20).default([]),
  template: z.string().optional(),
});
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

export const HardwareSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  boardId: z.string().min(1),
  /** Radio features the firmware uses; affects validation (e.g. ESP32 ADC2 + Wi-Fi). */
  features: z.object({ wifi: z.boolean().default(false), bluetooth: z.boolean().default(false) }).default({ wifi: false, bluetooth: false }),
  /** External supply notes / voltage if not USB-powered. */
  powerSource: z.enum(['usb', 'external']).default('usb'),
  notes: z.string().max(4000).default(''),
});
export type HardwareModel = z.infer<typeof HardwareSchema>;

export const BOARD_NODE = 'board';

const idString = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'ids start with a letter and contain letters, digits, _ or -');

export const EndpointSchema = z.object({
  /** "board" or a component instance id. */
  node: z.string().min(1),
  pin: z.string().min(1),
});
export type Endpoint = z.infer<typeof EndpointSchema>;

export const PropValueSchema = z.union([z.number(), z.string(), z.boolean()]);
export type PropValue = z.infer<typeof PropValueSchema>;

export const ComponentInstanceSchema = z.object({
  id: idString.refine((s) => s !== BOARD_NODE, '"board" is reserved'),
  type: z.string().min(1),
  label: z.string().min(1).max(40),
  props: z.record(z.string(), PropValueSchema).default({}),
  x: z.number().finite(),
  y: z.number().finite(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
});
export type ComponentInstance = z.infer<typeof ComponentInstanceSchema>;

export const WireSchema = z.object({
  id: idString,
  from: EndpointSchema,
  to: EndpointSchema,
  color: z.string().max(20).optional(),
  /** Optional intermediate routing points (canvas coordinates). */
  points: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
});
export type Wire = z.infer<typeof WireSchema>;

export const CircuitSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    board: z.object({ x: z.number().finite(), y: z.number().finite() }).default({ x: 0, y: 0 }),
    components: z.array(ComponentInstanceSchema).default([]),
    wires: z.array(WireSchema).default([]),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    c.components.forEach((comp, i) => {
      if (ids.has(comp.id)) ctx.addIssue({ code: 'custom', path: ['components', i, 'id'], message: `duplicate component id "${comp.id}"` });
      ids.add(comp.id);
    });
    const wireIds = new Set<string>();
    c.wires.forEach((w, i) => {
      if (wireIds.has(w.id)) ctx.addIssue({ code: 'custom', path: ['wires', i, 'id'], message: `duplicate wire id "${w.id}"` });
      wireIds.add(w.id);
    });
  });
export type Circuit = z.infer<typeof CircuitSchema>;

export function emptyCircuit(): Circuit {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, board: { x: 0, y: 0 }, components: [], wires: [] };
}

/** In-memory aggregate of the three project files plus the location on disk. */
export interface ProjectModel {
  root: string;
  manifest: ProjectManifest;
  hardware: HardwareModel;
  circuit: Circuit;
}

export const PROJECT_DIR = '.iotos';
export const PROJECT_FILES = {
  manifest: '.iotos/project.json',
  hardware: '.iotos/hardware.json',
  circuit: '.iotos/circuit.json',
} as const;
export const BUILD_DIR = '.iotos/build';
