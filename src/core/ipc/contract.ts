import type { BuiltContext, ContextSectionId, ContextSectionReport } from '../ai/context';
import type { DebugAnalysis } from '../ai/schemas';
import type { AIProviderId } from '../ai/types';
import type { Diagnostic } from '../diagnostics';
import type { SerializedError } from '../errors';
import type { SizeReport } from '../parsers/compiler';
import type { FlashFailureCode } from '../parsers/tools';
import type { Circuit, Dependency, HardwareModel, ProjectManifest } from '../project/schema';
import type { Proposal, Selection } from '../proposals/proposal';
import type { UsbChipFamily } from '../registry/usbChips';
import type { Language } from '../registry/types';
import type { LineEnding, SerialLine } from '../serial/lines';

/**
 * The single typed contract between the UI and the backend services. Both
 * transports (Electron IPC and the localhost HTTP/SSE host) carry exactly these
 * methods and events; the UI never talks to services any other way.
 */

/* ----------------------------- shared DTOs ---------------------------- */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogEntry {
  t: string;
  level: LogLevel;
  scope: string;
  message: string;
  fields?: Record<string, unknown>;
}

export interface AppInfo {
  version: string;
  runtime: 'electron' | 'browser-host';
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  electronVersion: string | null;
  workspaceDir: string;
  logFile: string | null;
  canPickDirectories: boolean;
}

export interface FileNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: FileNode[];
}

export interface ProjectSummary {
  root: string;
  id: string | null;
  name: string;
  description: string;
  boardId: string | null;
  language: Language | null;
  componentCount: number;
  updatedAt: string | null;
  pinned: boolean;
  lastOpenedAt: string | null;
  /** 'ok' or a load error code */
  status: 'ok' | 'error';
  error?: string;
  tags: string[];
}

export interface ProjectSnapshot {
  root: string;
  manifest: ProjectManifest;
  hardware: HardwareModel;
  circuit: Circuit;
  tree: FileNode[];
  warnings: string[];
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export type ToolState = 'installed' | 'missing' | 'invalid-version' | 'unsupported' | 'error';

export interface ToolStatus {
  id: string;
  name: string;
  state: ToolState;
  version: string | null;
  path: string | null;
  purpose: string;
  message: string;
  fix: string | null;
  docsUrl: string | null;
}

export interface CoreStatus {
  core: string;
  installed: string | null;
  boards: string[];
  indexUrl: string | null;
}

export interface SetupCheck {
  id: string;
  title: string;
  status: 'ok' | 'warning' | 'missing' | 'error';
  detail: string;
  fix: string | null;
  action: SetupAction | null;
}

export type SetupAction = { kind: 'install-core'; boardId: string } | { kind: 'open-url'; url: string } | { kind: 'open-settings'; section: string };

export interface SetupReport {
  checks: SetupCheck[];
  generatedAt: string;
}

export type DeviceState = 'CONNECTED' | 'DISCONNECTED' | 'DRIVER_MISSING' | 'PORT_BUSY' | 'UNKNOWN';

export interface BoardCandidate {
  boardId: string;
  confidence: 'exact' | 'likely' | 'possible';
  note?: string;
}

export interface Device {
  id: string;
  port: string;
  state: DeviceState;
  vid: string | null;
  pid: string | null;
  serialNumber: string | null;
  manufacturer: string | null;
  product: string | null;
  usbChip: { family: UsbChipFamily; chip: string | null };
  candidates: BoardCandidate[];
  /** Held by the IoT-OS serial monitor. */
  inUse: boolean;
  firstSeen: string;
  lastSeen: string;
}

export interface DeviceDiagnosis {
  port: string;
  device: Device | null;
  findings: { level: 'ok' | 'info' | 'warning' | 'error'; message: string }[];
  holders: string[];
}

export interface UsbDeviceReport {
  name: string;
  vid: string | null;
  pid: string | null;
  manufacturer: string | null;
  serialNumber: string | null;
  family: UsbChipFamily;
  chip: string | null;
  serialPorts: string[];
  driverState: 'ok' | 'missing' | 'not-required' | 'unknown';
  driver: { name: string; vendor: string; downloadUrl: string | null; builtIn: boolean; guidance: string };
}

export interface DriverScan {
  supported: boolean;
  method: string;
  devices: UsbDeviceReport[];
  message: string;
}

export interface SerialStatus {
  open: boolean;
  port: string | null;
  baud: number | null;
  bytesIn: number;
  bytesOut: number;
  linesBuffered: number;
  error: string | null;
}

export interface SerialOpenOptions {
  port: string;
  baud: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd';
  /** Reopen automatically when the device is unplugged and plugged back in. */
  autoReconnect?: boolean;
}

export type LibraryEcosystem = 'arduino' | 'micropython-mip';

export interface LibraryInfo {
  ecosystem: LibraryEcosystem;
  name: string;
  latest: string | null;
  versions: string[];
  author: string | null;
  sentence: string | null;
  architectures: string[];
  /** Compatibility with the open project's board. */
  compatibility: 'compatible' | 'incompatible' | 'unknown';
  website: string | null;
}

export interface InstalledLibrary {
  ecosystem: LibraryEcosystem;
  name: string;
  version: string;
  latest: string | null;
  updateAvailable: boolean;
  location: string | null;
  architectures: string[];
  compatibility: 'compatible' | 'incompatible' | 'unknown';
  dependencies: string[];
}

export interface DependencyResolution {
  ecosystem: LibraryEcosystem;
  declared: Dependency[];
  required: Dependency[];
  status: {
    name: string;
    declaredVersion: string | null;
    installedVersion: string | null;
    state: 'ok' | 'missing' | 'version-mismatch' | 'not-declared' | 'unknown';
  }[];
  /** Whether installation state could be determined (needs the tool). */
  checked: boolean;
  message: string;
}

export interface ProcessRecord {
  id: string;
  tool: string;
  /** Redacted display command. */
  command: string;
  cwd: string | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out';
  durationMs: number | null;
  purpose: string;
}

export type BuildStepId = 'validate-project' | 'validate-hardware' | 'check-sync' | 'resolve-dependencies' | 'select-toolchain' | 'compile' | 'artifact';

export interface BuildStep {
  id: BuildStepId;
  title: string;
  status: 'pending' | 'running' | 'ok' | 'warning' | 'failed' | 'skipped';
  durationMs: number | null;
  detail: string | null;
}

export interface BuildResult {
  id: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'blocked';
  startedAt: string;
  durationMs: number;
  boardId: string;
  fqbn: string | null;
  language: Language;
  steps: BuildStep[];
  diagnostics: Diagnostic[];
  artifacts: { path: string; kind: 'hex' | 'bin' | 'elf' | 'uf2' | 'py'; bytes: number }[];
  size: SizeReport | null;
  outputTail: string[];
  processId: string | null;
  message: string;
}

export interface FlashCheck {
  id: string;
  status: 'ok' | 'warning' | 'blocked';
  message: string;
  /** If set, the user can confirm this warning to proceed. */
  confirmable: boolean;
}

export interface FlashResult {
  status: 'succeeded' | 'failed' | 'cancelled' | 'needs-confirmation' | 'blocked';
  port: string;
  boardId: string;
  method: string;
  checks: FlashCheck[];
  durationMs: number;
  failure: { code: FlashFailureCode; message: string; hint: string } | null;
  processId: string | null;
  message: string;
}

export interface PublicSettings {
  workspaceDir: string;
  ai: {
    provider: AIProviderId;
    models: Record<AIProviderId, string>;
    hasKey: Record<AIProviderId, boolean>;
    contextBudgetTokens: number;
  };
  toolPaths: Record<string, string>;
  serial: { defaultBaud: number; lineEnding: LineEnding; timestamps: boolean; maxLines: number };
  simulator: { speed: number };
  editor: { fontSize: number; wordWrap: boolean };
  secretStorage: 'os-keychain' | 'file';
}

export type SettingsUpdate = {
  workspaceDir?: string;
  ai?: { provider?: AIProviderId; models?: Partial<Record<AIProviderId, string>>; contextBudgetTokens?: number };
  toolPaths?: Record<string, string>;
  serial?: Partial<PublicSettings['serial']>;
  simulator?: Partial<PublicSettings['simulator']>;
  editor?: Partial<PublicSettings['editor']>;
};

export interface AiStatus {
  configured: boolean;
  provider: AIProviderId;
  model: string;
  message: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  t: string;
  context?: ContextSectionReport[];
  proposalId?: string;
  analysis?: DebugAnalysis;
  error?: SerializedError;
}

export interface ContextOptions {
  /** Sections the user excluded from context. */
  exclude?: ContextSectionId[];
  activeFile?: string;
  /** Unsaved editor content for the active file. */
  activeContent?: string;
}

export interface ProjectPlanPreview {
  planId: string;
  name: string;
  summary: string;
  boardId: string;
  language: Language;
  requirements: string[];
  assumptions: string[];
  components: { id: string; type: string; reason?: string | undefined }[];
  files: Record<string, string>;
  circuit: Circuit;
  hardware: HardwareModel;
  diagnostics: Diagnostic[];
  problems: string[];
  attempts: number;
}

/* ------------------------------- methods ------------------------------ */

export interface ApiSpec {
  'app.info': { args: void; result: AppInfo };
  'app.pickDirectory': { args: { title?: string }; result: string | null };
  'app.openExternal': { args: { url: string }; result: void };
  'app.exportDiagnostics': { args: void; result: { path: string } };
  'logs.recent': { args: { limit?: number }; result: LogEntry[] };

  'settings.get': { args: void; result: PublicSettings };
  'settings.update': { args: SettingsUpdate; result: PublicSettings };
  'settings.setApiKey': { args: { provider: AIProviderId; key: string | null }; result: PublicSettings };

  'project.list': { args: void; result: ProjectSummary[] };
  'project.create': { args: { name: string; boardId: string; language: Language; template: string; parentDir?: string }; result: ProjectSnapshot };
  'project.open': { args: { root: string }; result: ProjectSnapshot };
  'project.current': { args: void; result: ProjectSnapshot | null };
  'project.reload': { args: void; result: ProjectSnapshot };
  'project.close': { args: void; result: void };
  'project.saveModel': { args: { hardware?: HardwareModel; circuit?: Circuit; manifest?: Partial<Pick<ProjectManifest, 'name' | 'description' | 'dependencies' | 'runtime' | 'toolchain' | 'tags'>> }; result: ProjectSnapshot };
  'project.rename': { args: { root: string; name: string }; result: ProjectSummary };
  'project.duplicate': { args: { root: string; name: string }; result: ProjectSummary };
  'project.delete': { args: { root: string }; result: void };
  'project.setPinned': { args: { root: string; pinned: boolean }; result: ProjectSummary[] };
  'project.syncPins': { args: void; result: Proposal | null };
  'project.generateDocs': { args: { kind: 'hardware' | 'setup' }; result: Proposal | null };
  'project.diagnostics': { args: void; result: Diagnostic[] };

  'fs.tree': { args: void; result: FileNode[] };
  'fs.read': { args: { path: string }; result: { content: string; mtimeMs: number } };
  'fs.write': { args: { path: string; content: string; expectedMtimeMs?: number }; result: { mtimeMs: number } };
  'fs.create': { args: { path: string; kind: 'file' | 'dir'; content?: string }; result: void };
  'fs.rename': { args: { from: string; to: string }; result: void };
  'fs.delete': { args: { path: string }; result: void };
  'fs.search': { args: { query: string; regex?: boolean; caseSensitive?: boolean }; result: SearchMatch[] };

  'setup.check': { args: void; result: SetupReport };
  'toolchain.status': { args: { refresh?: boolean }; result: ToolStatus[] };
  'toolchain.cores': { args: void; result: CoreStatus[] };
  'toolchain.installCore': { args: { boardId: string }; result: { ok: boolean; message: string; processId: string | null } };

  'devices.list': { args: void; result: Device[] };
  'devices.refresh': { args: void; result: Device[] };
  'devices.diagnose': { args: { port: string }; result: DeviceDiagnosis };
  'drivers.scan': { args: void; result: DriverScan };

  'serial.open': { args: SerialOpenOptions; result: SerialStatus };
  'serial.close': { args: void; result: SerialStatus };
  'serial.write': { args: { data: string; lineEnding: LineEnding }; result: void };
  'serial.status': { args: void; result: SerialStatus };
  'serial.history': { args: { limit?: number }; result: SerialLine[] };
  'serial.clear': { args: void; result: void };

  'libraries.search': { args: { ecosystem: LibraryEcosystem; query: string }; result: LibraryInfo[] };
  'libraries.installed': { args: { ecosystem: LibraryEcosystem }; result: InstalledLibrary[] };
  'libraries.install': { args: { ecosystem: LibraryEcosystem; name: string; version?: string; addToProject?: boolean }; result: { ok: boolean; message: string; processId: string | null } };
  'libraries.uninstall': { args: { ecosystem: LibraryEcosystem; name: string; removeFromProject?: boolean }; result: { ok: boolean; message: string; processId: string | null } };
  'libraries.upgrade': { args: { ecosystem: LibraryEcosystem; name: string }; result: { ok: boolean; message: string; processId: string | null } };
  'libraries.resolve': { args: void; result: DependencyResolution };

  'build.run': { args: void; result: BuildResult };
  'build.cancel': { args: void; result: void };
  'build.last': { args: void; result: BuildResult | null };
  'build.firmwareHex': { args: void; result: { hex: string; builtAt: string; stale: boolean } | null };

  'flash.run': { args: { port: string; confirmed?: string[] }; result: FlashResult };
  'flash.cancel': { args: void; result: void };

  'process.list': { args: void; result: ProcessRecord[] };
  'process.output': { args: { id: string }; result: string };

  'ai.status': { args: void; result: AiStatus };
  'ai.test': { args: void; result: { ok: boolean; message: string; latencyMs: number | null } };
  'ai.previewContext': { args: { intent: 'chat' | 'debug-serial' | 'fix-build'; options?: ContextOptions }; result: BuiltContext };
  'ai.chat': { args: { message: string; options?: ContextOptions }; result: ChatTurn };
  'ai.history': { args: void; result: ChatTurn[] };
  'ai.clearHistory': { args: void; result: void };
  'ai.explain': { args: { subject: string; options?: ContextOptions }; result: ChatTurn };
  'ai.editCode': { args: { instruction: string; options?: ContextOptions }; result: ChatTurn };
  'ai.fixBuild': { args: { question?: string; options?: ContextOptions }; result: ChatTurn };
  'ai.debugSerial': { args: { question?: string; options?: ContextOptions }; result: ChatTurn };
  'ai.planCircuit': { args: { request: string }; result: ChatTurn };
  'ai.planProject': { args: { idea: string; boardId?: string; language?: Language }; result: ProjectPlanPreview };
  'ai.createProjectFromPlan': { args: { planId: string; parentDir?: string }; result: ProjectSnapshot };
  'ai.cancel': { args: void; result: void };

  'proposals.list': { args: void; result: Proposal[] };
  'proposals.get': { args: { id: string }; result: Proposal };
  'proposals.apply': { args: { id: string; selection: Selection }; result: { proposal: Proposal; written: string[] } };
  'proposals.reject': { args: { id: string }; result: Proposal };
}

export type ApiMethod = keyof ApiSpec;
export type ApiArgs<K extends ApiMethod> = ApiSpec[K]['args'];
export type ApiResult<K extends ApiMethod> = ApiSpec[K]['result'];

/* -------------------------------- events ------------------------------ */

export interface EventMap {
  'project.changed': ProjectSnapshot | null;
  'fs.changed': { paths: string[]; external: boolean };
  'devices.changed': Device[];
  'serial.data': { lines: SerialLine[]; partial: string };
  'serial.status': SerialStatus;
  'build.progress': { buildId: string; steps: BuildStep[] };
  'build.finished': BuildResult;
  'flash.progress': { percent: number | null; message: string };
  'flash.finished': FlashResult;
  'process.started': ProcessRecord;
  'process.output': { id: string; stream: 'stdout' | 'stderr'; text: string };
  'process.exited': ProcessRecord;
  'proposals.changed': Proposal[];
  'ai.status': AiStatus;
  'log.entry': LogEntry;
}

export type EventTopic = keyof EventMap;

/** Wire format for a method result. */
export type RpcResponse<T> = { ok: true; result: T } | { ok: false; error: SerializedError };
