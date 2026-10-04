import { autoLayout, wireColor } from '../circuit/layout';
import { connect, removeComponents } from '../circuit/operations';
import type { Diagnostic } from '../diagnostics';
import { IotosError } from '../errors';
import { buildProject, firmwarePaths, type BuiltProject, type ProjectSpec } from '../project/factory';
import { BOARD_NODE, type Circuit, type Endpoint, type HardwareModel } from '../project/schema';
import { getRegistry, isGpio, type HardwareRegistry } from '../registry/registry';
import type { Language } from '../registry/types';
import { validateHardware } from '../validation/engine';
import type { BuiltContext } from './context';
import { parseStructured } from './json';
import { BASE_SYSTEM, FIRMWARE_RULES, JSON_RULES, WIRING_RULES, boardCatalog, boardPinTable, componentCatalog } from './prompts';
import {
  CircuitPlanSchema,
  CodeEditResponseSchema,
  DebugAnalysisSchema,
  ProjectPlanSchema,
  type CircuitPlan,
  type CodeEditResponse,
  type DebugAnalysis,
  type ProjectPlan,
} from './schemas';
import type { AIMessage, AIProvider } from './types';

/**
 * AI task orchestration. Pure with respect to I/O: the provider is injected, so
 * every task is testable with a scripted provider. No task writes files or runs
 * commands — results become proposals the user reviews.
 */

export interface TaskDeps {
  provider: AIProvider;
  registry?: HardwareRegistry;
  signal?: AbortSignal;
  /** Max model calls for structured tasks (initial + repairs). */
  maxAttempts?: number;
}

const MAX_TOKENS = 16000;

function withContext(context: BuiltContext | null, text: string): string {
  return context ? `<project_context>\n${context.text}\n</project_context>\n\n${text}` : text;
}

async function call(deps: TaskDeps, system: string, messages: AIMessage[], json: boolean): Promise<string> {
  const res = await deps.provider.complete({ system, messages: [...messages], maxTokens: MAX_TOKENS, json, ...(deps.signal ? { signal: deps.signal } : {}) });
  if (!res.text.trim()) throw new IotosError('AI_MALFORMED_RESPONSE', 'The AI returned an empty response', { details: { stopReason: res.stopReason } });
  return res.text;
}

/**
 * Calls the model for a structured result, re-asking with the validation
 * problems when parsing or checking fails.
 */
async function structured<T>(
  deps: TaskDeps,
  system: string,
  firstMessage: string,
  parse: (text: string) => T,
  check: (value: T) => string[],
): Promise<{ value: T; problems: string[]; attempts: number }> {
  const max = deps.maxAttempts ?? 3;
  const messages: AIMessage[] = [{ role: 'user', content: firstMessage }];
  let last: { value: T; problems: string[] } | null = null;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= max; attempt++) {
    const text = await call(deps, system, messages, true);
    messages.push({ role: 'assistant', content: text });
    let problems: string[];
    try {
      const value = parse(text);
      problems = check(value);
      last = { value, problems };
      if (problems.length === 0) return { value, problems, attempts: attempt };
    } catch (err) {
      lastError = err;
      problems = [(err as Error).message];
    }
    if (attempt < max) {
      messages.push({
        role: 'user',
        content: `Your previous answer has these problems found by IoT-OS deterministic checks:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nReturn the complete corrected JSON object (not a diff). ${JSON_RULES}`,
      });
    }
  }
  if (last) return { ...last, attempts: max };
  throw lastError instanceof Error ? lastError : new IotosError('AI_MALFORMED_RESPONSE', 'The AI did not return a usable answer');
}

/* ------------------------------------------------------------------ */

export async function chat(deps: TaskDeps, input: { context: BuiltContext | null; history: AIMessage[]; message: string }): Promise<string> {
  const messages: AIMessage[] = [...input.history, { role: 'user', content: withContext(input.context, input.message) }];
  return call(deps, BASE_SYSTEM, messages, false);
}

export async function explain(deps: TaskDeps, input: { context: BuiltContext; subject: string }): Promise<string> {
  return call(deps, BASE_SYSTEM, [{ role: 'user', content: withContext(input.context, `Explain the following for the developer. Reference concrete lines, pins and parts from the context.\n\n${input.subject}`) }], false);
}

export interface EditCodeInput {
  context: BuiltContext;
  instruction: string;
  /** Files that may be created or modified (project-relative). */
  editableFiles: string[];
  /** Generated pin config path; edits to it are rejected. */
  configFile: string;
  language: Language;
}

export async function editCode(deps: TaskDeps, input: EditCodeInput): Promise<{ response: CodeEditResponse; problems: string[]; attempts: number }> {
  const system = `${BASE_SYSTEM}\n\n${FIRMWARE_RULES}`;
  const ext = input.language === 'micropython' ? '.py' : '.cpp/.h';
  const prompt = withContext(
    input.context,
    `Task: ${input.instruction}

Return JSON: {"summary": string, "edits": [{"path": string, "content": string}], "notes": string[]}
- Each edit contains the COMPLETE new content of the file.
- Only edit these existing files or create new ${ext} files under src/ (or docs/ for documentation): ${input.editableFiles.join(', ') || '(none)'}
- Never edit ${input.configFile} or anything under .iotos/.
- Put caveats, assumptions and anything the user must do manually in "notes".
${JSON_RULES}`,
  );
  const r = await structured(
    deps,
    system,
    prompt,
    (t) => parseStructured(CodeEditResponseSchema, t),
    (v) => {
      const problems: string[] = [];
      for (const e of v.edits) {
        if (e.path === input.configFile) problems.push(`${e.path} is generated from the circuit and must not be edited`);
        else if (!input.editableFiles.includes(e.path) && !/^(src|docs|include|lib)\//.test(e.path)) problems.push(`${e.path} is outside the editable project folders`);
      }
      return problems;
    },
  );
  // Never let a disallowed edit through, even after the repair attempts.
  const response = { ...r.value, edits: r.value.edits.filter((e) => e.path !== input.configFile && (input.editableFiles.includes(e.path) || /^(src|docs|include|lib)\//.test(e.path))) };
  return { response, problems: r.problems, attempts: r.attempts };
}

export async function analyze(deps: TaskDeps, input: { context: BuiltContext; kind: 'build' | 'serial'; question?: string; editableFiles: string[]; configFile: string }): Promise<DebugAnalysis> {
  const focus =
    input.kind === 'build'
      ? 'Diagnose the build failure shown in BUILD OUTPUT. Identify the root cause and the minimal fix.'
      : 'Analyze the SERIAL OUTPUT for runtime problems (crashes, resets, sensor failures, wrong values) and relate them to firmware and wiring.';
  const prompt = withContext(
    input.context,
    `${focus}${input.question ? `\nDeveloper question: ${input.question}` : ''}

Return JSON:
{"summary": string,
 "observations": string[]   // facts directly visible in the context
 "likelyCauses": [{"cause": string, "confidence": "high"|"medium"|"low", "evidence": string}],
 "assumptions": string[]    // things you assumed but could not verify
 "suggestedFixes": string[],
 "edits": [{"path": string, "content": string}]  // optional complete-file fixes; only ${input.editableFiles.join(', ')}; never ${input.configFile}
}
Use "low" confidence when the context does not establish the cause. ${JSON_RULES}`,
  );
  const r = await structured(
    deps,
    `${BASE_SYSTEM}\n\n${FIRMWARE_RULES}`,
    prompt,
    (t) => parseStructured(DebugAnalysisSchema, t),
    (v) => v.edits.filter((e) => e.path === input.configFile || !input.editableFiles.includes(e.path)).map((e) => `Edit to ${e.path} is not allowed`),
  );
  return { ...r.value, edits: r.value.edits.filter((e) => e.path !== input.configFile && input.editableFiles.includes(e.path)) };
}

/* ------------------------- circuit planning ------------------------ */

function parseEndpoint(s: string): Endpoint {
  const i = s.indexOf('.');
  return { node: s.slice(0, i), pin: s.slice(i + 1) };
}

/** Checks a plan's parts and endpoints against the registry. */
export function checkPlanAgainstRegistry(
  plan: Pick<CircuitPlan, 'components' | 'connections'>,
  boardId: string,
  existing: Circuit | null,
  registry: HardwareRegistry = getRegistry(),
): string[] {
  const problems: string[] = [];
  const types = new Map<string, string>();
  for (const c of existing?.components ?? []) types.set(c.id, c.type);
  const seen = new Set<string>();
  for (const c of plan.components) {
    if (seen.has(c.id)) problems.push(`Duplicate component id "${c.id}"`);
    seen.add(c.id);
    const def = registry.getComponent(c.type);
    if (!def) {
      problems.push(`Unknown component type "${c.type}" for ${c.id}. Use only types from the component catalog.`);
      continue;
    }
    for (const k of Object.keys(c.props)) if (!def.props.some((p) => p.key === k)) problems.push(`${c.id}: ${def.name} has no property "${k}"`);
    types.set(c.id, c.type);
  }
  for (const conn of plan.connections) {
    for (const s of [conn.from, conn.to]) {
      const e = parseEndpoint(s);
      if (e.node === BOARD_NODE) {
        if (!registry.resolveBoardPin(boardId, e.pin)) problems.push(`"${s}": pin ${e.pin} does not exist on board ${boardId}`);
        continue;
      }
      const type = types.get(e.node);
      if (!type) problems.push(`"${s}": unknown component "${e.node}"`);
      else if (!registry.getComponentPin(type, e.pin)) {
        const def = registry.getComponent(type);
        if (def) problems.push(`"${s}": ${def.name} has no pin "${e.pin}" (pins: ${def.pins.map((p) => p.id).join(', ')})`);
      }
    }
  }
  return problems;
}

function blockingIssues(diags: Diagnostic[]): string[] {
  return diags.filter((d) => d.severity === 'error' || d.severity === 'blocking').map((d) => `${d.severity.toUpperCase()} ${d.code}: ${d.message}${d.hint ? ` (${d.hint})` : ''}`);
}

/** Applies a circuit plan on top of an existing circuit (update/add/remove/connect). */
export function applyCircuitPlan(existing: Circuit, plan: CircuitPlan, boardId: string, registry: HardwareRegistry = getRegistry()): Circuit {
  const board = registry.requireBoard(boardId);
  let c = removeComponents(existing, plan.remove);
  const existingIds = new Set(c.components.map((x) => x.id));
  const fresh: Circuit['components'] = [];
  const components = c.components.map((inst) => {
    const p = plan.components.find((x) => x.id === inst.id);
    return p ? { ...inst, type: p.type, label: (p.label ?? inst.label).toUpperCase(), props: { ...inst.props, ...p.props } } : inst;
  });
  for (const p of plan.components) {
    if (existingIds.has(p.id)) continue;
    const def = registry.requireComponent(p.type);
    fresh.push({ id: p.id, type: p.type, label: (p.label ?? p.id).toUpperCase(), props: { ...Object.fromEntries(def.props.map((d) => [d.key, d.default])), ...p.props }, x: 0, y: 0, rotation: 0 });
  }
  // Lay out only the new parts, below/right of the existing ones.
  const placed = autoLayout({ ...c, components: fresh }, board, registry).components.map((x) => ({ ...x, y: x.y + (components.length ? 40 : 0) }));
  c = { ...c, components: [...components, ...placed] };
  let signal = 0;
  for (const conn of plan.connections) {
    const from = parseEndpoint(conn.from);
    const to = parseEndpoint(conn.to);
    const canon = (e: Endpoint): Endpoint => {
      if (e.node !== BOARD_NODE) return e;
      const bp = registry.resolveBoardPin(boardId, e.pin);
      return bp ? { node: BOARD_NODE, pin: bp.id } : e;
    };
    const boardEnd = [from, to].find((e) => e.node === BOARD_NODE);
    const bp = boardEnd ? registry.resolveBoardPin(boardId, boardEnd.pin) : undefined;
    const kind = bp && !isGpio(bp) ? (bp.kind === 'ground' ? 'ground' : 'power') : 'signal';
    c = connect(c, canon(from), canon(to), { color: wireColor(kind, kind === 'signal' ? signal++ : 0) }).circuit;
  }
  return c;
}

export interface CircuitPlanResult {
  plan: CircuitPlan;
  circuit: Circuit;
  hardware: HardwareModel;
  diagnostics: Diagnostic[];
  problems: string[];
  attempts: number;
}

export async function planCircuit(
  deps: TaskDeps,
  input: { context: BuiltContext; request: string; hardware: HardwareModel; circuit: Circuit },
): Promise<CircuitPlanResult> {
  const registry = deps.registry ?? getRegistry();
  const board = registry.requireBoard(input.hardware.boardId);
  const system = `${BASE_SYSTEM}\n\n${WIRING_RULES}`;
  const prompt = withContext(
    input.context,
    `Design or modify the circuit: ${input.request}

${boardPinTable(board)}

Component catalog (use only these types):
${componentCatalog(registry)}

Return JSON:
{"summary": string,
 "components": [{"id": "led1", "type": "led", "label"?: string, "props"?: {}, "reason"?: string}],  // new parts, or existing ids to update
 "connections": [{"from": "board.GPIO25", "to": "r1.1"}],   // wires to ADD
 "remove": string[],     // existing component ids to delete
 "wifi"?: boolean,
 "notes": string[]}
Keep existing parts unless the request requires changing them. ${JSON_RULES}`,
  );
  let resultCircuit = input.circuit;
  let hardware = input.hardware;
  let diagnostics: Diagnostic[] = [];
  const r = await structured(
    deps,
    system,
    prompt,
    (t) => parseStructured(CircuitPlanSchema, t),
    (plan) => {
      const base = removeComponents(input.circuit, plan.remove);
      const problems = checkPlanAgainstRegistry(plan, board.id, base, registry);
      if (problems.length) return problems;
      resultCircuit = applyCircuitPlan(input.circuit, plan, board.id, registry);
      hardware = plan.wifi === undefined ? input.hardware : { ...input.hardware, features: { ...input.hardware.features, wifi: plan.wifi } };
      diagnostics = validateHardware(hardware, resultCircuit, registry).diagnostics;
      return blockingIssues(diagnostics);
    },
  );
  return { plan: r.value, circuit: resultCircuit, hardware, diagnostics, problems: r.problems, attempts: r.attempts };
}

/* ------------------------- project builder ------------------------- */

const SYMBOL_USE = /\b([A-Z][A-Z0-9]*_(?:PIN|TRIG_PIN|ECHO_PIN|RST_PIN|DC_PIN|CS_PIN|BL_PIN|CE_PIN|CSN_PIN|IN[1-4]_PIN|RX_PIN|TX_PIN)|I2C_SDA|I2C_SCL|SPI_SCK|SPI_MOSI|SPI_MISO)\b/g;

export function planToSpec(plan: ProjectPlan): ProjectSpec {
  return {
    name: plan.name,
    description: plan.summary,
    language: plan.language,
    boardId: plan.board.id,
    features: { wifi: plan.wifi, bluetooth: plan.bluetooth },
    components: plan.components.map((c) => ({ id: c.id, type: c.type, ...(c.label ? { label: c.label } : {}), props: c.props })),
    connections: plan.connections.map((c) => ({ from: parseEndpoint(c.from), to: parseEndpoint(c.to) })),
    files: Object.fromEntries(plan.firmware.files.map((f) => [f.path, f.content])),
    dependencies: plan.dependencies,
    docs: { overview: [`## Overview`, '', plan.summary, '', plan.requirements.length ? `### Requirements\n${plan.requirements.map((r) => `- ${r}`).join('\n')}` : '', plan.overview, plan.assumptions.length ? `### Assumptions\n${plan.assumptions.map((a) => `- ${a}`).join('\n')}` : ''].filter(Boolean).join('\n') },
    tags: ['ai-generated'],
  };
}

export interface ProjectPlanResult {
  plan: ProjectPlan;
  spec: ProjectSpec;
  built: BuiltProject | null;
  problems: string[];
  attempts: number;
}

export async function planProject(deps: TaskDeps, input: { idea: string; boardId?: string; language?: Language }): Promise<ProjectPlanResult> {
  const registry = deps.registry ?? getRegistry();
  const prefs = [input.boardId ? `The user selected board ${input.boardId}.` : 'Choose the most suitable board.', input.language ? `Use language ${input.language}.` : ''].filter(Boolean).join(' ');
  const pinTables = input.boardId ? boardPinTable(registry.requireBoard(input.boardId)) : registry.listBoards().filter((b) => b.architecture === 'esp32' || b.architecture === 'avr').map(boardPinTable).join('\n\n');
  const prompt = `Design a complete IoT project for this idea:
"""${input.idea}"""
${prefs}

Boards:
${boardCatalog(registry)}

${pinTables}

Component catalog (use only these types; layout aids are not needed):
${componentCatalog(registry)}

${WIRING_RULES}

${FIRMWARE_RULES}

Return JSON:
{"name": string, "summary": string, "requirements": string[],
 "language": "arduino-cpp"|"micropython",
 "board": {"id": string, "reason": string},
 "wifi": boolean, "bluetooth": boolean,
 "components": [{"id": "dht1", "type": "dht22", "label"?: string, "props"?: {}, "reason": string}],
 "connections": [{"from": "board.3V3", "to": "dht1.VCC"}],
 "firmware": {"files": [{"path": "src/main.cpp", "content": string}]},
 "dependencies": [{"ecosystem": "arduino"|"micropython-mip", "name": string, "version"?: string}],
 "overview": string,      // Markdown: how it works, calibration, safety notes
 "assumptions": string[]}
${JSON_RULES}`;
  let built: BuiltProject | null = null;
  const r = await structured(
    deps,
    BASE_SYSTEM,
    prompt,
    (t) => parseStructured(ProjectPlanSchema, t),
    (plan) => {
      built = null;
      const problems: string[] = [];
      const board = registry.getBoard(plan.board.id);
      if (!board) return [`Unknown board "${plan.board.id}"`];
      if (!board.languages.includes(plan.language)) problems.push(`${board.name} does not support ${plan.language}`);
      const paths = firmwarePaths(plan.language);
      if (!plan.firmware.files.some((f) => f.path === paths.entry)) problems.push(`Firmware must include ${paths.entry}`);
      if (plan.firmware.files.some((f) => f.path === paths.configFile)) problems.push(`Do not supply ${paths.configFile}; it is generated`);
      problems.push(...checkPlanAgainstRegistry(plan, board.id, null, registry));
      if (problems.length) return problems;
      const spec = planToSpec(plan);
      try {
        built = buildProject(spec, { id: 'ai-preview', now: new Date(0).toISOString() }, registry);
      } catch (err) {
        return [(err as Error).message];
      }
      const b = built as BuiltProject;
      problems.push(...blockingIssues(b.diagnostics));
      // Firmware must only use pin symbols the generated config defines.
      const config = b.files[paths.configFile] ?? '';
      const used = new Set<string>();
      for (const f of plan.firmware.files) for (const m of f.content.matchAll(SYMBOL_USE)) used.add(m[1]!);
      for (const s of used) if (!new RegExp(`\\b${s}\\b`).test(config)) problems.push(`Firmware uses ${s}, which the generated ${paths.configFile} does not define (check component ids and symbol suffixes)`);
      return problems;
    },
  );
  return { plan: r.value, spec: planToSpec(r.value), built, problems: r.problems, attempts: r.attempts };
}
