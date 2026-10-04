import { buildGraph, deriveBom, derivePinMap } from '../circuit/graph';
import type { Diagnostic } from '../diagnostics';
import type { Circuit, HardwareModel, ProjectManifest } from '../project/schema';
import { getRegistry, type HardwareRegistry } from '../registry/registry';
import { LANGUAGE_LABELS } from '../registry/types';

/**
 * AI context engine. Assembles a structured, prioritized, size-bounded context
 * from the unified project model. Deterministic: the same inputs produce the
 * same context text, and the UI shows exactly which sections were included.
 */

export type ContextIntent = 'chat' | 'explain-code' | 'edit-code' | 'fix-build' | 'debug-serial' | 'generate-firmware' | 'hardware';

export type ContextSectionId =
  | 'project'
  | 'hardware'
  | 'circuit'
  | 'diagnostics'
  | 'active-file'
  | 'source'
  | 'dependencies'
  | 'toolchain'
  | 'device'
  | 'build'
  | 'serial'
  | 'simulator';

export interface ContextFile {
  path: string;
  content: string;
  /** 1-based line ranges of interest (e.g. around compiler errors). */
  focus?: number[];
}

export interface ContextInput {
  manifest: ProjectManifest;
  hardware: HardwareModel;
  circuit: Circuit;
  diagnostics: Diagnostic[];
  activeFile?: ContextFile;
  files?: ContextFile[];
  installedLibraries?: { name: string; version: string }[];
  toolchain?: { name: string; status: string; version?: string }[];
  device?: { port: string; state: string; description?: string; vidPid?: string; boardGuess?: string };
  build?: { status: string; diagnostics: Diagnostic[]; outputTail: string[] };
  serial?: { port: string; baud: number; lines: string[]; runtimeIssues: Diagnostic[] };
  simulator?: { mode: string; summary: string };
}

export interface ContextSectionReport {
  id: ContextSectionId;
  title: string;
  tokens: number;
  truncated: boolean;
  included: boolean;
}

export interface BuiltContext {
  text: string;
  sections: ContextSectionReport[];
  tokens: number;
  budget: number;
}

interface Section {
  id: ContextSectionId;
  title: string;
  content: string;
  /** Lower = more important. */
  priority: number;
  /** How to shrink when over budget. */
  truncate: 'tail' | 'head' | 'none';
}

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

const PRIORITIES: Record<ContextIntent, Partial<Record<ContextSectionId, number>>> = {
  chat: { project: 0, hardware: 1, circuit: 2, 'active-file': 3, diagnostics: 4, dependencies: 5, device: 6, build: 7, serial: 8, simulator: 9, toolchain: 10 },
  'explain-code': { 'active-file': 0, project: 1, circuit: 2, hardware: 3, dependencies: 4, diagnostics: 5 },
  'edit-code': { 'active-file': 0, project: 1, circuit: 2, hardware: 3, source: 4, dependencies: 5, diagnostics: 6, build: 7 },
  'fix-build': { build: 0, source: 1, 'active-file': 2, project: 3, dependencies: 4, toolchain: 5, hardware: 6, circuit: 7, diagnostics: 8 },
  'debug-serial': { serial: 0, source: 1, circuit: 2, hardware: 3, device: 4, project: 5, dependencies: 6, diagnostics: 7, build: 8, simulator: 9 },
  'generate-firmware': { project: 0, circuit: 1, hardware: 2, dependencies: 3, source: 4, 'active-file': 5, diagnostics: 6 },
  hardware: { project: 0, hardware: 1, circuit: 2, diagnostics: 3, source: 4 },
};

function numbered(content: string, focus?: number[], radius = 15): { text: string; partial: boolean } {
  const lines = content.split('\n');
  if (!focus || focus.length === 0) return { text: lines.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n'), partial: false };
  const keep = new Set<number>();
  for (const f of focus) for (let i = Math.max(1, f - radius); i <= Math.min(lines.length, f + radius); i++) keep.add(i);
  const out: string[] = [];
  let last = 0;
  for (let i = 1; i <= lines.length; i++) {
    if (!keep.has(i)) continue;
    if (i > last + 1) out.push('    | …');
    out.push(`${String(i).padStart(4)}| ${lines[i - 1]}`);
    last = i;
  }
  if (last < lines.length) out.push('    | …');
  return { text: out.join('\n'), partial: true };
}

function fence(path: string, body: string): string {
  const lang = path.endsWith('.py') ? 'python' : path.endsWith('.json') ? 'json' : path.endsWith('.md') ? 'markdown' : 'cpp';
  return `File: ${path}\n\`\`\`${lang}\n${body}\n\`\`\``;
}

function formatDiag(d: Diagnostic): string {
  const loc = d.target?.file ? ` (${d.target.file}${d.target.line ? `:${d.target.line}` : ''}${d.target.column ? `:${d.target.column}` : ''})` : d.target?.componentId ? ` [${d.target.componentId}]` : '';
  return `- ${d.severity.toUpperCase()} ${d.code}${loc}: ${d.message}${d.hint ? ` — hint: ${d.hint}` : ''}`;
}

export function hardwareSummary(hardware: HardwareModel, circuit: Circuit, registry: HardwareRegistry = getRegistry()): { hardware: string; circuit: string } {
  const board = registry.getBoard(hardware.boardId);
  if (!board) return { hardware: `Board: unknown id "${hardware.boardId}"`, circuit: '' };
  const hw = [
    `Board: ${board.name} (id ${board.id}), MCU ${board.mcu} @ ${board.clockMhz} MHz, ${board.logicVoltage} V logic${board.fiveVoltTolerant ? ' (5 V tolerant)' : ' (NOT 5 V tolerant)'}`,
    `Radio: Wi-Fi ${board.wifi ? 'yes' : 'no'}, Bluetooth ${board.bluetooth ? 'yes' : 'no'}; project uses Wi-Fi: ${hardware.features.wifi}, Bluetooth: ${hardware.features.bluetooth}`,
    `Default buses: ${board.buses
      .filter((b) => b.isDefault)
      .map((b) => `${b.kind.toUpperCase()} ${Object.entries(b.pins).map(([k, v]) => `${k}=${v}`).join(' ')}`)
      .join('; ')}`,
  ];
  const graph = buildGraph(circuit, board.id, registry);
  const pinMap = derivePinMap(graph);
  const bom = deriveBom(circuit, registry);
  const lines: string[] = [];
  lines.push(`Components: ${bom.map((l) => `${l.quantity}× ${l.name} [${l.labels.join(', ')}]`).join('; ') || 'none'}`);
  for (const c of circuit.components) {
    const def = registry.getComponent(c.type);
    const props = Object.entries(c.props)
      .filter(([k]) => !def?.props.find((p) => p.key === k)?.simulation)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ');
    lines.push(`- ${c.id} "${c.label}": ${c.type}${props ? ` (${props})` : ''}`);
  }
  lines.push('Wires:');
  for (const w of circuit.wires) lines.push(`- ${w.from.node}.${w.from.pin} — ${w.to.node}.${w.to.pin}`);
  lines.push('Derived pin map (component pin -> board pin, GPIO number used in firmware):');
  for (const b of pinMap) lines.push(`- ${b.componentLabel}.${b.componentPin} -> ${b.boardPin.id} (GPIO ${b.boardPin.gpio}${b.via ? `, via ${b.via}` : ''})`);
  return { hardware: hw.join('\n'), circuit: lines.join('\n') };
}

export function buildContext(
  input: ContextInput,
  intent: ContextIntent,
  budgetTokens = 12000,
  registry: HardwareRegistry = getRegistry(),
  exclude: readonly ContextSectionId[] = [],
): BuiltContext {
  const pri = PRIORITIES[intent];
  const sections: Section[] = [];
  const add = (s: Omit<Section, 'priority'>) => {
    const p = pri[s.id];
    if (p !== undefined && s.content.trim() && !exclude.includes(s.id)) sections.push({ ...s, priority: p });
  };

  const m = input.manifest;
  add({
    id: 'project',
    title: 'PROJECT',
    truncate: 'none',
    content: [`Name: ${m.name}`, m.description ? `Description: ${m.description}` : '', `Language: ${LANGUAGE_LABELS[m.language]}`, `Firmware entry: ${m.firmware.entry}; generated pin config: ${m.firmware.configFile}`].filter(Boolean).join('\n'),
  });
  const hw = hardwareSummary(input.hardware, input.circuit, registry);
  add({ id: 'hardware', title: 'HARDWARE', truncate: 'none', content: hw.hardware });
  add({ id: 'circuit', title: 'CIRCUIT', truncate: 'head', content: hw.circuit });
  if (input.diagnostics.length) add({ id: 'diagnostics', title: 'DIAGNOSTICS (deterministic checks)', truncate: 'head', content: input.diagnostics.map(formatDiag).join('\n') });
  if (input.activeFile) {
    const n = numbered(input.activeFile.content, input.activeFile.focus);
    add({ id: 'active-file', title: 'ACTIVE FILE', truncate: 'head', content: fence(input.activeFile.path, n.text) });
  }
  const others = (input.files ?? []).filter((f) => f.path !== input.activeFile?.path);
  if (others.length) {
    add({ id: 'source', title: 'SOURCE FILES', truncate: 'head', content: others.map((f) => fence(f.path, numbered(f.content, f.focus).text)).join('\n\n') });
  }
  const deps = [`Declared: ${m.dependencies.map((d) => `${d.name}${d.version ? `@${d.version}` : ''} (${d.ecosystem})`).join(', ') || 'none'}`];
  if (input.installedLibraries) deps.push(`Installed: ${input.installedLibraries.map((l) => `${l.name}@${l.version}`).join(', ') || 'none'}`);
  add({ id: 'dependencies', title: 'DEPENDENCIES', truncate: 'head', content: deps.join('\n') });
  if (input.toolchain?.length) add({ id: 'toolchain', title: 'TOOLCHAIN', truncate: 'none', content: input.toolchain.map((t) => `- ${t.name}: ${t.status}${t.version ? ` ${t.version}` : ''}`).join('\n') });
  if (input.device) {
    const d = input.device;
    add({ id: 'device', title: 'DEVICE', truncate: 'none', content: `Port ${d.port}, state ${d.state}${d.description ? `, ${d.description}` : ''}${d.vidPid ? `, USB ${d.vidPid}` : ''}${d.boardGuess ? `, identified as ${d.boardGuess}` : ''}` });
  }
  if (input.build) {
    const b = input.build;
    add({
      id: 'build',
      title: 'BUILD OUTPUT',
      truncate: 'tail',
      content: [`Status: ${b.status}`, b.diagnostics.length ? `Parsed problems:\n${b.diagnostics.map(formatDiag).join('\n')}` : '', b.outputTail.length ? `Raw output (tail):\n${b.outputTail.join('\n')}` : ''].filter(Boolean).join('\n'),
    });
  }
  if (input.serial) {
    const s = input.serial;
    add({
      id: 'serial',
      title: 'SERIAL OUTPUT',
      truncate: 'tail',
      content: [`Port ${s.port} @ ${s.baud} baud`, s.runtimeIssues.length ? `Detected signatures:\n${s.runtimeIssues.map(formatDiag).join('\n')}` : '', `Recent lines (oldest first):\n${s.lines.join('\n')}`].filter(Boolean).join('\n'),
    });
  }
  if (input.simulator) add({ id: 'simulator', title: 'SIMULATOR', truncate: 'head', content: `Mode: ${input.simulator.mode}\n${input.simulator.summary}` });

  sections.sort((a, b) => a.priority - b.priority);
  const reports: ContextSectionReport[] = [];
  const parts: string[] = [];
  let used = 0;
  for (const s of sections) {
    const header = `### ${s.title}\n`;
    const full = header + s.content;
    const tokens = estimateTokens(full);
    const remaining = budgetTokens - used;
    if (tokens <= remaining) {
      parts.push(full);
      used += tokens;
      reports.push({ id: s.id, title: s.title, tokens, truncated: false, included: true });
      continue;
    }
    if (s.truncate === 'none' || remaining < 200) {
      reports.push({ id: s.id, title: s.title, tokens: 0, truncated: false, included: false });
      continue;
    }
    const chars = remaining * 4 - header.length - 40;
    const body = s.truncate === 'tail' ? `[… earlier content omitted]\n${s.content.slice(-chars)}` : `${s.content.slice(0, chars)}\n[… truncated]`;
    const text = header + body;
    parts.push(text);
    const t = estimateTokens(text);
    used += t;
    reports.push({ id: s.id, title: s.title, tokens: t, truncated: true, included: true });
  }
  return { text: parts.join('\n\n'), sections: reports, tokens: used, budget: budgetTokens };
}
