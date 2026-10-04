import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AI_PROVIDER_IDS } from '../core/ai/types';
import { IotosError, toSerializedError } from '../core/errors';
import type { ApiArgs, ApiMethod, ApiResult, AppInfo, RpcResponse } from '../core/ipc/contract';
import { buildGraph, derivePinMap } from '../core/circuit/graph';
import { generateHardwareDoc, generateSetupDoc } from '../core/docs/hardwareDocs';
import { CircuitSchema, HardwareSchema, DependencySchema, PROJECT_FILES } from '../core/project/schema';
import { requiredDependencies, mergeDependencies } from '../core/project/dependencies';
import { getRegistry, BUILTIN_BOARDS } from '../core/registry/registry';
import { DRIVERS } from '../core/registry/usbChips';
import { LANGUAGES } from '../core/registry/types';
import { expectedPinSymbols, generateConfigFile } from '../core/sync/pinSync';
import { validateHardware } from '../core/validation/engine';
import { TOOL_SPECS } from './process/tools';
import type { Services } from './services';

type Handler<K extends ApiMethod> = (args: ApiArgs<K>) => Promise<ApiResult<K>> | ApiResult<K>;
type Handlers = { [K in ApiMethod]: { args: z.ZodType; handle: Handler<K> } };

const path = z.string().min(1).max(1024);
const relPath = z.string().min(1).max(512);
const none = z.undefined().or(z.null()).or(z.object({}).strict()).optional();
const contextOptions = z
  .object({
    exclude: z.array(z.string()).max(20).optional(),
    activeFile: relPath.optional(),
    activeContent: z.string().max(2_000_000).optional(),
  })
  .optional();
const ecosystem = z.enum(['arduino', 'micropython-mip']);

/** Hosts IoT-OS may open in the system browser (docs, vendors, firmware pages). */
function allowedHosts(): Set<string> {
  const urls = [
    ...Object.values(DRIVERS).map((d) => d.downloadUrl),
    ...Object.values(TOOL_SPECS).map((t) => t.docsUrl),
    ...BUILTIN_BOARDS.flatMap((b) => [...b.references, b.toolchain.micropython?.firmwareUrl]),
    'https://github.com/micropython/micropython-lib',
    'https://docs.arduino.cc/',
    'https://www.arduino.cc/reference/en/libraries/',
    'https://console.anthropic.com/',
    'https://platform.openai.com/',
    'https://aistudio.google.com/',
  ];
  const hosts = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      hosts.add(new URL(u).host);
    } catch {
      /* ignore */
    }
  }
  return hosts;
}

export interface HostCapabilities {
  info: () => Omit<AppInfo, 'workspaceDir' | 'logFile'>;
  pickDirectory: (title?: string) => Promise<string | null>;
  openExternal: (url: string) => Promise<void>;
}

export function createApi(s: Services, host: HostCapabilities) {
  const hosts = allowedHosts();
  const h: Handlers = {
    'app.info': { args: none, handle: () => ({ ...host.info(), workspaceDir: s.settings.raw.workspaceDir, logFile: s.logger.filePath }) },
    'app.pickDirectory': { args: z.object({ title: z.string().max(200).optional() }).optional(), handle: (a) => host.pickDirectory(a?.title) },
    'app.openExternal': {
      args: z.object({ url: z.string().url().max(2000) }),
      handle: async ({ url }) => {
        const u = new URL(url);
        if (u.protocol !== 'https:' || !hosts.has(u.host)) throw new IotosError('INVALID_ARGUMENT', `Opening ${u.host} is not allowed`);
        await host.openExternal(u.toString());
      },
    },
    'app.exportDiagnostics': {
      args: none,
      handle: async () => {
        const file = join(s.opts.dataDir, `iotos-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        const data = {
          app: { ...host.info(), workspaceDir: s.settings.raw.workspaceDir },
          settings: s.settings.public(),
          tools: await s.toolchains.status(),
          devices: s.devices.list(),
          lastBuild: s.build.lastResult() && { ...s.build.lastResult(), outputTail: s.build.lastResult()!.outputTail.slice(-40) },
          processes: s.runner.list().slice(0, 50),
          logs: s.logger.recent(1000),
        };
        await writeFile(file, s.logger.redact(JSON.stringify(data, null, 2)), { mode: 0o600 });
        return { path: file };
      },
    },
    'logs.recent': { args: z.object({ limit: z.number().int().min(1).max(5000).optional() }).optional(), handle: (a) => s.logger.recent(a?.limit ?? 500) },

    'settings.get': { args: none, handle: () => s.settings.public() },
    'settings.update': {
      args: z.object({
        workspaceDir: path.optional(),
        ai: z.object({ provider: z.enum(AI_PROVIDER_IDS).optional(), models: z.record(z.string(), z.string().max(100)).optional(), contextBudgetTokens: z.number().int().optional() }).optional(),
        toolPaths: z.record(z.string(), z.string().max(1024)).optional(),
        serial: z.object({}).passthrough().optional(),
        simulator: z.object({}).passthrough().optional(),
        editor: z.object({}).passthrough().optional(),
      }),
      handle: (a) => {
        const r = s.settings.update(a);
        if (a.toolPaths) s.resolver.clearCache();
        return r;
      },
    },
    'settings.setApiKey': { args: z.object({ provider: z.enum(AI_PROVIDER_IDS), key: z.string().max(500).nullable() }), handle: (a) => s.settings.setApiKey(a.provider, a.key) },

    'project.list': { args: none, handle: () => s.projects.list() },
    'project.create': {
      args: z.object({ name: z.string().trim().min(1).max(80), boardId: z.string(), language: z.enum(LANGUAGES), template: z.string(), parentDir: path.optional() }),
      handle: (a) => s.projects.create(a),
    },
    'project.open': { args: z.object({ root: path }), handle: (a) => s.projects.open(a.root) },
    'project.current': { args: none, handle: async () => (s.projects.openProject ? s.projects.snapshot() : null) },
    'project.reload': { args: none, handle: () => s.projects.reload() },
    'project.close': { args: none, handle: () => s.projects.close() },
    'project.saveModel': {
      args: z.object({
        hardware: HardwareSchema.optional(),
        circuit: CircuitSchema.optional(),
        manifest: z
          .object({
            name: z.string().trim().min(1).max(80).optional(),
            description: z.string().max(2000).optional(),
            dependencies: z.array(DependencySchema).optional(),
            runtime: z.object({ port: z.string().max(300).optional(), baud: z.number().int().positive() }).optional(),
            toolchain: z.object({ boardOptions: z.record(z.string(), z.string()) }).optional(),
            tags: z.array(z.string().max(40)).optional(),
          })
          .optional(),
      }),
      handle: (a) => s.projects.saveModel(a),
    },
    'project.rename': { args: z.object({ root: path, name: z.string() }), handle: (a) => s.projects.rename(a.root, a.name) },
    'project.duplicate': { args: z.object({ root: path, name: z.string().trim().min(1).max(80) }), handle: (a) => s.projects.duplicate(a.root, a.name) },
    'project.delete': { args: z.object({ root: path }), handle: (a) => s.projects.delete(a.root) },
    'project.setPinned': { args: z.object({ root: path, pinned: z.boolean() }), handle: (a) => s.projects.setPinned(a.root, a.pinned) },
    'project.syncPins': {
      args: none,
      handle: async () => {
        const { model } = s.projects.require();
        const board = getRegistry().requireBoard(model.hardware.boardId);
        const g = buildGraph(model.circuit, board.id);
        const content = generateConfigFile(model.manifest.language, expectedPinSymbols(g, derivePinMap(g), model.manifest.language), board);
        return s.proposals.create({ title: 'Sync pin configuration from circuit', description: `Regenerates ${model.manifest.firmware.configFile} from the circuit so firmware pin numbers match the wiring.`, origin: 'generator', files: { [model.manifest.firmware.configFile]: content } });
      },
    },
    'project.generateDocs': {
      args: z.object({ kind: z.enum(['hardware', 'setup']) }),
      handle: async ({ kind }) => {
        const { model } = s.projects.require();
        const board = getRegistry().requireBoard(model.hardware.boardId);
        if (kind === 'hardware') {
          const diags = validateHardware(model.hardware, model.circuit).diagnostics;
          return s.proposals.create({ title: 'Generate wiring guide & hardware list', description: 'Regenerates docs/HARDWARE.md from the circuit.', origin: 'generator', files: { 'docs/HARDWARE.md': generateHardwareDoc(model.manifest.name, model.circuit, model.hardware, diags) } });
        }
        const deps = mergeDependencies(model.manifest.dependencies, requiredDependencies(model.circuit, board, model.manifest.language));
        return s.proposals.create({ title: 'Generate setup guide', description: 'Regenerates docs/SETUP.md.', origin: 'generator', files: { 'docs/SETUP.md': generateSetupDoc(model.manifest.name, board, model.manifest.language, deps) } });
      },
    },
    'project.diagnostics': { args: none, handle: () => s.projects.diagnostics() },

    'fs.tree': { args: none, handle: () => s.projects.require().fs.tree() },
    'fs.read': { args: z.object({ path: relPath }), handle: (a) => s.projects.require().fs.read(a.path) },
    'fs.write': {
      args: z.object({ path: relPath, content: z.string().max(8_000_000), expectedMtimeMs: z.number().optional() }),
      handle: (a) => {
        if (Object.values(PROJECT_FILES).includes(a.path as (typeof PROJECT_FILES)[keyof typeof PROJECT_FILES])) {
          throw new IotosError('INVALID_ARGUMENT', 'Edit project model files through the project views (they are validated on save)');
        }
        return s.projects.require().fs.write(a.path, a.content, a.expectedMtimeMs);
      },
    },
    'fs.create': { args: z.object({ path: relPath, kind: z.enum(['file', 'dir']), content: z.string().max(8_000_000).optional() }), handle: (a) => s.projects.require().fs.create(a.path, a.kind, a.content ?? '') },
    'fs.rename': { args: z.object({ from: relPath, to: relPath }), handle: (a) => s.projects.require().fs.rename(a.from, a.to) },
    'fs.delete': { args: z.object({ path: relPath }), handle: (a) => s.projects.require().fs.delete(a.path, s.trash) },
    'fs.search': { args: z.object({ query: z.string().min(1).max(500), regex: z.boolean().optional(), caseSensitive: z.boolean().optional() }), handle: (a) => s.projects.require().fs.search(a.query, a) },

    'setup.check': { args: none, handle: () => s.setup.check() },
    'toolchain.status': { args: z.object({ refresh: z.boolean().optional() }).optional(), handle: (a) => s.toolchains.status(a?.refresh ?? false) },
    'toolchain.cores': { args: none, handle: () => s.toolchains.cores() },
    'toolchain.installCore': { args: z.object({ boardId: z.string() }), handle: (a) => s.toolchains.installCore(a.boardId) },

    'devices.list': { args: none, handle: () => s.devices.list() },
    'devices.refresh': { args: none, handle: () => s.devices.refresh() },
    'devices.diagnose': { args: z.object({ port: path }), handle: (a) => s.devices.diagnose(a.port) },
    'drivers.scan': {
      args: none,
      handle: async () => {
        const r = await s.drivers.scan();
        s.devices.setDriverFindings(r.devices);
        return r;
      },
    },

    'serial.open': {
      args: z.object({ port: path, baud: z.number().int(), dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).optional(), stopBits: z.union([z.literal(1), z.literal(2)]).optional(), parity: z.enum(['none', 'even', 'odd']).optional(), autoReconnect: z.boolean().optional() }),
      handle: (a) => s.serial.open(a),
    },
    'serial.close': { args: none, handle: () => s.serial.close() },
    'serial.write': { args: z.object({ data: z.string().max(65536), lineEnding: z.enum(['none', 'lf', 'cr', 'crlf']) }), handle: (a) => s.serial.write(a.data, a.lineEnding) },
    'serial.status': { args: none, handle: () => s.serial.status() },
    'serial.history': { args: z.object({ limit: z.number().int().min(1).max(200_000).optional() }).optional(), handle: (a) => s.serial.history.tail(a?.limit ?? 5000) },
    'serial.clear': { args: none, handle: () => s.serial.clearHistory() },

    'libraries.search': { args: z.object({ ecosystem, query: z.string().max(200) }), handle: (a) => s.libraries.search(a.ecosystem, a.query) },
    'libraries.installed': { args: z.object({ ecosystem }), handle: (a) => s.libraries.installed(a.ecosystem) },
    'libraries.install': { args: z.object({ ecosystem, name: z.string().min(1).max(200), version: z.string().max(50).optional(), addToProject: z.boolean().optional() }), handle: (a) => s.libraries.install(a.ecosystem, a.name, a.version, a.addToProject ?? true) },
    'libraries.uninstall': { args: z.object({ ecosystem, name: z.string().min(1).max(200), removeFromProject: z.boolean().optional() }), handle: (a) => s.libraries.uninstall(a.ecosystem, a.name, a.removeFromProject ?? true) },
    'libraries.upgrade': { args: z.object({ ecosystem, name: z.string().min(1).max(200) }), handle: (a) => s.libraries.upgrade(a.ecosystem, a.name) },
    'libraries.resolve': { args: none, handle: () => s.libraries.resolve() },

    'build.run': { args: none, handle: () => s.build.run() },
    'build.cancel': { args: none, handle: () => s.build.cancel() },
    'build.last': { args: none, handle: () => s.build.lastResult() },
    'build.firmwareHex': { args: none, handle: () => s.build.firmwareHex() },

    'flash.run': { args: z.object({ port: path, confirmed: z.array(z.string().max(50)).max(20).optional() }), handle: (a) => s.flash.run(a.port, a.confirmed ?? []) },
    'flash.cancel': { args: none, handle: () => s.flash.cancel() },

    'process.list': { args: none, handle: () => s.runner.list() },
    'process.output': { args: z.object({ id: z.string().max(100) }), handle: (a) => s.runner.output(a.id) },

    'ai.status': { args: none, handle: () => s.ai.status() },
    'ai.test': { args: none, handle: () => s.ai.test() },
    'ai.previewContext': { args: z.object({ intent: z.enum(['chat', 'debug-serial', 'fix-build']), options: contextOptions }), handle: (a) => s.ai.previewContext(a.intent, (a.options ?? {}) as never) },
    'ai.chat': { args: z.object({ message: z.string().min(1).max(20000), options: contextOptions }), handle: (a) => s.ai.chat(a.message, (a.options ?? {}) as never) },
    'ai.history': { args: none, handle: () => s.ai.getHistory() },
    'ai.clearHistory': { args: none, handle: () => s.ai.clearHistory() },
    'ai.explain': { args: z.object({ subject: z.string().min(1).max(50000), options: contextOptions }), handle: (a) => s.ai.explain(a.subject, (a.options ?? {}) as never) },
    'ai.editCode': { args: z.object({ instruction: z.string().min(1).max(20000), options: contextOptions }), handle: (a) => s.ai.editCode(a.instruction, (a.options ?? {}) as never) },
    'ai.fixBuild': { args: z.object({ question: z.string().max(5000).optional(), options: contextOptions }), handle: (a) => s.ai.fixBuild(a.question, (a.options ?? {}) as never) },
    'ai.debugSerial': { args: z.object({ question: z.string().max(5000).optional(), options: contextOptions }), handle: (a) => s.ai.debugSerial(a.question, (a.options ?? {}) as never) },
    'ai.planCircuit': { args: z.object({ request: z.string().min(1).max(10000) }), handle: (a) => s.ai.planCircuit(a.request) },
    'ai.planProject': { args: z.object({ idea: z.string().min(3).max(10000), boardId: z.string().optional(), language: z.enum(LANGUAGES).optional() }), handle: (a) => s.ai.planProject(a.idea, a.boardId, a.language) },
    'ai.createProjectFromPlan': { args: z.object({ planId: z.string().max(100), parentDir: path.optional() }), handle: (a) => s.ai.createProjectFromPlan(a.planId, a.parentDir) },
    'ai.cancel': { args: none, handle: () => s.ai.cancel() },

    'proposals.list': { args: none, handle: () => s.proposals.list() },
    'proposals.get': { args: z.object({ id: z.string() }), handle: (a) => s.proposals.get(a.id) },
    'proposals.apply': { args: z.object({ id: z.string(), selection: z.record(z.string(), z.union([z.literal('all'), z.literal('none'), z.array(z.number().int().min(0))])) }), handle: (a) => s.proposals.apply(a.id, a.selection) },
    'proposals.reject': { args: z.object({ id: z.string() }), handle: (a) => s.proposals.reject(a.id) },
  };

  const log = s.logger.scope('api');

  /** Dispatch one call. Unknown methods and invalid arguments are rejected. */
  async function call(method: string, args: unknown): Promise<RpcResponse<unknown>> {
    if (!Object.prototype.hasOwnProperty.call(h, method)) {
      return { ok: false, error: { code: 'UNKNOWN_METHOD', message: `Unknown method ${method}` } };
    }
    const entry = h[method as ApiMethod] as { args: z.ZodType; handle: (a: unknown) => unknown };
    const parsed = entry.args.safeParse(args === null ? undefined : args);
    if (!parsed.success) {
      return { ok: false, error: { code: 'INVALID_ARGUMENT', message: `Invalid arguments for ${method}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` } };
    }
    try {
      const result = await entry.handle(parsed.data);
      return { ok: true, result: result ?? null };
    } catch (err) {
      const e = toSerializedError(err);
      if (e.code === 'INTERNAL') log.error(`${method} failed`, { error: err });
      else log.debug(`${method} -> ${e.code}`, { message: e.message });
      return { ok: false, error: e };
    }
  }

  return { call, methods: Object.keys(h) as ApiMethod[] };
}

export type Api = ReturnType<typeof createApi>;
