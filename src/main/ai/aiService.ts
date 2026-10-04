import { randomUUID } from 'node:crypto';
import { buildContext, type BuiltContext, type ContextFile, type ContextInput, type ContextIntent } from '../../core/ai/context';
import { analyze, chat, editCode, explain, planCircuit, planProject, type TaskDeps } from '../../core/ai/tasks';
import type { AIMessage, AIProvider, AIProviderId } from '../../core/ai/types';
import { PROVIDER_LABELS } from '../../core/ai/types';
import { buildGraph, derivePinMap } from '../../core/circuit/graph';
import { IotosError, toSerializedError } from '../../core/errors';
import type { AiStatus, ChatTurn, ContextOptions, ProjectPlanPreview, ProjectSnapshot } from '../../core/ipc/contract';
import { detectRuntimeIssues } from '../../core/parsers/runtime';
import type { ProjectSpec } from '../../core/project/factory';
import { serializeProjectFile } from '../../core/project/migrations';
import { PROJECT_FILES } from '../../core/project/schema';
import { summarizeCircuitChange } from '../../core/proposals/proposal';
import { getRegistry } from '../../core/registry/registry';
import type { Language } from '../../core/registry/types';
import { expectedPinSymbols, generateConfigFile } from '../../core/sync/pinSync';
import type { BuildPipeline } from '../build/buildPipeline';
import type { DeviceManager } from '../devices/deviceManager';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../logging/logger';
import type { ProjectService } from '../project/projectService';
import type { ProposalStore } from '../proposals/proposalStore';
import type { SerialManager } from '../serial/serialManager';
import type { SettingsService } from '../settings/settings';
import type { ToolchainManager } from '../toolchain/toolchainManager';
import { createProvider, type ProviderConfig } from './providers';

export type ProviderFactory = (id: AIProviderId, cfg: ProviderConfig) => AIProvider;

const HISTORY_TURNS = 12;

/**
 * Connects the provider-agnostic AI tasks to the live project: assembles context
 * from every subsystem, keeps chat history, and turns AI output into proposals.
 * The AI never writes files or runs tools directly.
 */
export class AiService {
  private history: ChatTurn[] = [];
  private plans = new Map<string, { spec: ProjectSpec; at: number }>();
  private inflight: AbortController | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly projects: ProjectService,
    private readonly proposals: ProposalStore,
    private readonly build: BuildPipeline,
    private readonly serial: SerialManager,
    private readonly devices: DeviceManager,
    private readonly toolchains: ToolchainManager,
    private readonly bus: EventBus,
    private readonly log: ScopedLogger,
    private readonly providerFactory: ProviderFactory = createProvider,
  ) {
    bus.on('project.changed', (snap) => {
      if (!snap) this.history = [];
    });
  }

  status(): AiStatus {
    const s = this.settings.public();
    const provider = s.ai.provider;
    const configured = s.ai.hasKey[provider];
    return {
      configured,
      provider,
      model: s.ai.models[provider],
      message: configured ? `${PROVIDER_LABELS[provider]} · ${s.ai.models[provider]}` : `No API key for ${PROVIDER_LABELS[provider]}. Add one in Settings → AI.`,
    };
  }

  private provider(): AIProvider {
    const id = this.settings.raw.ai.provider;
    const key = this.settings.apiKey(id);
    if (!key) throw new IotosError('AI_NOT_CONFIGURED', `No API key configured for ${PROVIDER_LABELS[id]}`, { hint: 'Open Settings → AI and add an API key, or set the provider environment variable.' });
    return this.providerFactory(id, { apiKey: key, model: this.settings.model(id) });
  }

  private deps(): TaskDeps {
    this.inflight?.abort();
    this.inflight = new AbortController();
    return { provider: this.provider(), signal: this.inflight.signal };
  }

  cancel(): void {
    this.inflight?.abort();
    this.inflight = null;
  }

  async test(): Promise<{ ok: boolean; message: string; latencyMs: number | null }> {
    const t0 = Date.now();
    try {
      const r = await this.provider().complete({ system: 'You are a connectivity check.', messages: [{ role: 'user', content: 'Reply with the single word OK.' }], maxTokens: 64 });
      return { ok: true, message: `Connected to ${r.model}: "${r.text.trim().slice(0, 40)}"`, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, message: (err as Error).message, latencyMs: null };
    }
  }

  /* ---------------------------- context ---------------------------- */

  private async contextInput(intent: ContextIntent, options: ContextOptions = {}): Promise<ContextInput> {
    const { fs, model } = this.projects.require();
    const { manifest } = model;
    const diagnostics = (await this.projects.diagnostics()).filter((d) => d.severity !== 'info' || d.source === 'sync');
    const input: ContextInput = { manifest, hardware: model.hardware, circuit: model.circuit, diagnostics };

    if (options.activeFile) {
      const content = options.activeContent ?? (await fs.readOrNull(options.activeFile));
      if (content !== null) input.activeFile = { path: options.activeFile, content };
    }
    const last = this.build.lastResult();
    const files = new Map<string, ContextFile>();
    const addFile = async (path: string, focus?: number) => {
      if (path === input.activeFile?.path) {
        if (focus) input.activeFile.focus = [...(input.activeFile.focus ?? []), focus];
        return;
      }
      const existing = files.get(path);
      if (existing) {
        if (focus) existing.focus = [...(existing.focus ?? []), focus];
        return;
      }
      const content = await fs.readOrNull(path).catch(() => null);
      if (content !== null) files.set(path, { path, content, ...(focus ? { focus: [focus] } : {}) });
    };
    if (intent === 'fix-build' && last) {
      for (const d of last.diagnostics) if (d.target?.file && d.severity === 'error') await addFile(d.target.file, d.target.line);
      input.build = { status: last.status, diagnostics: last.diagnostics.filter((d) => d.source === 'compiler' || d.source === 'linker' || d.source === 'toolchain'), outputTail: last.outputTail.slice(-60) };
    } else if (last && last.status !== 'succeeded' && intent === 'chat') {
      input.build = { status: last.status, diagnostics: last.diagnostics.filter((d) => d.severity === 'error').slice(0, 10), outputTail: [] };
    }
    if (intent === 'debug-serial' || intent === 'fix-build' || intent === 'generate-firmware' || intent === 'edit-code') {
      await addFile(manifest.firmware.entry);
      await addFile(manifest.firmware.configFile);
    }
    if (files.size) input.files = [...files.values()];

    const tail = this.serial.history.tail(intent === 'debug-serial' ? 400 : 60).map((l) => l.text);
    if (tail.length && (intent === 'debug-serial' || intent === 'chat')) {
      const st = this.serial.status();
      input.serial = { port: st.port ?? '(closed)', baud: st.baud ?? 0, lines: tail, runtimeIssues: detectRuntimeIssues(tail) };
    }
    const port = this.serial.currentPort ?? manifest.runtime.port;
    const dev = port ? this.devices.get(port) : undefined;
    if (dev) {
      input.device = {
        port: dev.port,
        state: dev.state,
        ...(dev.usbChip.chip ? { description: dev.usbChip.chip } : {}),
        ...(dev.vid ? { vidPid: `${dev.vid}:${dev.pid}` } : {}),
        ...(dev.candidates[0] ? { boardGuess: `${dev.candidates[0].boardId} (${dev.candidates[0].confidence})` } : {}),
      };
    }
    if (intent === 'fix-build') {
      const tools = await this.toolchains.status();
      input.toolchain = tools.filter((t) => t.id === 'arduino-cli' || t.id === 'mpremote' || t.id === 'esptool').map((t) => ({ name: t.name, status: t.state, ...(t.version ? { version: t.version } : {}) }));
    }
    return input;
  }

  async previewContext(intent: ContextIntent, options: ContextOptions = {}): Promise<BuiltContext> {
    return buildContext(await this.contextInput(intent, options), intent, this.settings.raw.ai.contextBudgetTokens, getRegistry(), options.exclude ?? []);
  }

  private pushTurn(turn: ChatTurn): ChatTurn {
    this.history.push(turn);
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
    return turn;
  }

  private priorMessages(): AIMessage[] {
    return this.history
      .filter((t) => !t.error)
      .slice(-HISTORY_TURNS)
      .map((t) => ({ role: t.role, content: t.content }));
  }

  getHistory(): ChatTurn[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history = [];
  }

  /** Runs an AI operation, recording user + assistant turns and errors uniformly. */
  private async turn(userText: string, op: () => Promise<Omit<ChatTurn, 't' | 'role'>>): Promise<ChatTurn> {
    this.pushTurn({ role: 'user', content: userText, t: new Date().toISOString() });
    try {
      const r = await op();
      return this.pushTurn({ role: 'assistant', t: new Date().toISOString(), ...r });
    } catch (err) {
      this.log.warn('AI operation failed', { error: err });
      return this.pushTurn({ role: 'assistant', content: (err as Error).message, t: new Date().toISOString(), error: toSerializedError(err) });
    } finally {
      this.inflight = null;
    }
  }

  async chat(message: string, options: ContextOptions = {}): Promise<ChatTurn> {
    const ctx = await this.previewContext('chat', options);
    const history = this.priorMessages();
    return this.turn(message, async () => ({ content: await chat(this.deps(), { context: ctx, history, message }), context: ctx.sections }));
  }

  async explain(subject: string, options: ContextOptions = {}): Promise<ChatTurn> {
    const ctx = await this.previewContext('explain-code', options);
    return this.turn(`Explain: ${subject.slice(0, 300)}`, async () => ({ content: await explain(this.deps(), { context: ctx, subject }), context: ctx.sections }));
  }

  private async editableFiles(): Promise<string[]> {
    const { fs, model } = this.projects.require();
    return (await fs.listFiles()).filter((p) => /^(src|include|docs)\//.test(p) && p !== model.manifest.firmware.configFile);
  }

  async editCode(instruction: string, options: ContextOptions = {}): Promise<ChatTurn> {
    const ctx = await this.previewContext('edit-code', options);
    const { model } = this.projects.require();
    const editable = await this.editableFiles();
    return this.turn(instruction, async () => {
      const r = await editCode(this.deps(), { context: ctx, instruction, editableFiles: editable, configFile: model.manifest.firmware.configFile, language: model.manifest.language });
      const proposal = await this.proposals.create({
        title: `AI: ${instruction.slice(0, 80)}`,
        description: r.response.summary,
        origin: 'ai',
        files: Object.fromEntries(r.response.edits.map((e) => [e.path, e.content])),
        notes: [...r.response.notes, ...r.problems.map((p) => `Rejected by IoT-OS checks: ${p}`)],
      });
      return { content: r.response.summary + (proposal ? '' : '\n\n_No file changes were proposed._'), context: ctx.sections, ...(proposal ? { proposalId: proposal.id } : {}) };
    });
  }

  async fixBuild(question: string | undefined, options: ContextOptions = {}): Promise<ChatTurn> {
    const last = this.build.lastResult();
    if (!last) throw new IotosError('INVALID_ARGUMENT', 'Run a build first');
    const ctx = await this.previewContext('fix-build', options);
    const { model } = this.projects.require();
    const editable = await this.editableFiles();
    return this.turn(question ?? 'Explain and fix the build failure', async () => {
      const analysis = await analyze(this.deps(), { context: ctx, kind: 'build', ...(question ? { question } : {}), editableFiles: editable, configFile: model.manifest.firmware.configFile });
      const proposal = analysis.edits.length
        ? await this.proposals.create({ title: 'AI: fix build', description: analysis.summary, origin: 'ai', files: Object.fromEntries(analysis.edits.map((e) => [e.path, e.content])), notes: analysis.assumptions.map((a) => `Assumption: ${a}`) })
        : null;
      return { content: analysis.summary, analysis, context: ctx.sections, ...(proposal ? { proposalId: proposal.id } : {}) };
    });
  }

  async debugSerial(question: string | undefined, options: ContextOptions = {}): Promise<ChatTurn> {
    if (this.serial.history.size === 0) throw new IotosError('INVALID_ARGUMENT', 'No serial output captured yet. Open the Serial Monitor first.');
    const ctx = await this.previewContext('debug-serial', options);
    const { model } = this.projects.require();
    const editable = await this.editableFiles();
    return this.turn(question ?? 'Analyze the serial output', async () => {
      const analysis = await analyze(this.deps(), { context: ctx, kind: 'serial', ...(question ? { question } : {}), editableFiles: editable, configFile: model.manifest.firmware.configFile });
      const proposal = analysis.edits.length
        ? await this.proposals.create({ title: 'AI: serial debugging fix', description: analysis.summary, origin: 'ai', files: Object.fromEntries(analysis.edits.map((e) => [e.path, e.content])) })
        : null;
      return { content: analysis.summary, analysis, context: ctx.sections, ...(proposal ? { proposalId: proposal.id } : {}) };
    });
  }

  async planCircuit(request: string): Promise<ChatTurn> {
    const ctx = await this.previewContext('hardware');
    const { model } = this.projects.require();
    return this.turn(request, async () => {
      const r = await planCircuit(this.deps(), { context: ctx, request, hardware: model.hardware, circuit: model.circuit });
      const files: Record<string, string> = { [PROJECT_FILES.circuit]: serializeProjectFile(r.circuit) };
      if (JSON.stringify(r.hardware) !== JSON.stringify(model.hardware)) files[PROJECT_FILES.hardware] = serializeProjectFile(r.hardware);
      // Keep firmware pin config in sync with the proposed circuit.
      const board = getRegistry().getBoard(r.hardware.boardId);
      if (board) {
        const g = buildGraph(r.circuit, board.id);
        files[model.manifest.firmware.configFile] = generateConfigFile(model.manifest.language, expectedPinSymbols(g, derivePinMap(g), model.manifest.language), board);
      }
      const proposal = await this.proposals.create({
        title: `AI circuit: ${request.slice(0, 70)}`,
        description: r.plan.summary,
        origin: 'ai',
        files,
        summaries: { [PROJECT_FILES.circuit]: summarizeCircuitChange(model.circuit, r.circuit) },
        diagnostics: r.diagnostics,
        notes: [...r.plan.notes, ...r.problems.map((p) => `Unresolved after ${r.attempts} attempt(s): ${p}`)],
      });
      return { content: r.plan.summary, context: ctx.sections, ...(proposal ? { proposalId: proposal.id } : {}) };
    });
  }

  async planProject(idea: string, boardId?: string, language?: Language): Promise<ProjectPlanPreview> {
    try {
      const r = await planProject(this.deps(), { idea, ...(boardId ? { boardId } : {}), ...(language ? { language } : {}) });
      const planId = randomUUID();
      this.plans.set(planId, { spec: r.spec, at: Date.now() });
      for (const [id, p] of this.plans) if (Date.now() - p.at > 6 * 3600_000) this.plans.delete(id);
      return {
        planId,
        name: r.plan.name,
        summary: r.plan.summary,
        boardId: r.plan.board.id,
        language: r.plan.language,
        requirements: r.plan.requirements,
        assumptions: r.plan.assumptions,
        components: r.plan.components.map((c) => ({ id: c.id, type: c.type, reason: c.reason })),
        files: r.built?.files ?? Object.fromEntries(r.plan.firmware.files.map((f) => [f.path, f.content])),
        circuit: r.built?.circuit ?? { schemaVersion: 1, board: { x: 0, y: 0 }, components: [], wires: [] },
        hardware: r.built?.hardware ?? { schemaVersion: 1, boardId: r.plan.board.id, features: { wifi: r.plan.wifi, bluetooth: r.plan.bluetooth }, powerSource: 'usb', notes: '' },
        diagnostics: r.built?.diagnostics ?? [],
        problems: r.problems,
        attempts: r.attempts,
      };
    } finally {
      this.inflight = null;
    }
  }

  async createProjectFromPlan(planId: string, parentDir?: string): Promise<ProjectSnapshot> {
    const plan = this.plans.get(planId);
    if (!plan) throw new IotosError('PROPOSAL_NOT_FOUND', 'This project plan has expired; generate it again');
    const snap = await this.projects.createFromSpec(plan.spec, parentDir);
    this.plans.delete(planId);
    this.history = [];
    return snap;
  }
}
