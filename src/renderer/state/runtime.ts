import { create } from 'zustand';
import type { AiStatus, AppInfo, BuildResult, BuildStep, ChatTurn, Device, FlashResult, LogEntry, ProcessRecord, PublicSettings, SerialStatus } from '../../core/ipc/contract';
import type { Proposal } from '../../core/proposals/proposal';
import { SeriesBuffer, TelemetryParser } from '../../core/serial/telemetry';
import type { LineEnding, SerialLine } from '../../core/serial/lines';
import { call, errorMessage } from '../api/client';
import { useProject } from './project';
import { useUi } from './ui';

/* --------------------------------- app ---------------------------------- */

interface AppState {
  info: AppInfo | null;
  settings: PublicSettings | null;
  load(): Promise<void>;
  updateSettings(patch: Parameters<typeof call<'settings.update'>>[1]): Promise<void>;
}

export const useApp = create<AppState>((set) => ({
  info: null,
  settings: null,
  async load() {
    const [info, settings] = await Promise.all([call('app.info'), call('settings.get')]);
    set({ info, settings });
  },
  async updateSettings(patch) {
    try {
      set({ settings: await call('settings.update', patch) });
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
    }
  },
}));

/* ------------------------------- devices -------------------------------- */

interface DeviceState {
  devices: Device[];
  /** Port chosen for upload/serial. */
  selectedPort: string | null;
  setDevices(d: Device[]): void;
  refresh(): Promise<void>;
  select(port: string | null): void;
}

export const useDevices = create<DeviceState>((set, get) => ({
  devices: [],
  selectedPort: null,
  setDevices(devices) {
    const sel = get().selectedPort;
    const projPort = useProject.getState().snapshot?.manifest.runtime.port;
    const connected = devices.filter((d) => d.state === 'CONNECTED' || d.state === 'PORT_BUSY');
    let next = sel;
    if (!sel || !devices.some((d) => d.port === sel && d.state !== 'DISCONNECTED')) {
      next = connected.find((d) => d.port === projPort)?.port ?? connected[0]?.port ?? null;
    }
    set({ devices, selectedPort: next });
  },
  async refresh() {
    try {
      get().setDevices(await call('devices.refresh'));
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
    }
  },
  select(port) {
    set({ selectedPort: port });
  },
}));

/* ---------------------------- build & flash ----------------------------- */

interface BuildState {
  running: boolean;
  steps: BuildStep[];
  last: BuildResult | null;
  flashing: boolean;
  flashProgress: { percent: number | null; message: string } | null;
  lastFlash: FlashResult | null;
  pendingConfirm: FlashResult | null;
  build(): Promise<BuildResult | null>;
  upload(confirmed?: string[]): Promise<void>;
  setProgress(steps: BuildStep[]): void;
  finished(r: BuildResult): void;
}

export const useBuild = create<BuildState>((set, get) => ({
  running: false,
  steps: [],
  last: null,
  flashing: false,
  flashProgress: null,
  lastFlash: null,
  pendingConfirm: null,
  async build() {
    if (get().running) return null;
    set({ running: true, steps: [] });
    useUi.getState().showBottom('build');
    try {
      const r = await call('build.run');
      get().finished(r);
      return r;
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
      return null;
    } finally {
      set({ running: false });
    }
  },
  async upload(confirmed = []) {
    const port = useDevices.getState().selectedPort;
    if (!port) {
      useUi.getState().toast('warning', 'No board connected. Plug in a board or choose a port in Devices.');
      useUi.getState().setActivity('devices');
      return;
    }
    set({ flashing: true, flashProgress: { percent: null, message: 'Checking…' }, pendingConfirm: null });
    useUi.getState().showBottom('build');
    try {
      const r = await call('flash.run', { port, confirmed });
      set({ lastFlash: r });
      if (r.status === 'needs-confirmation') set({ pendingConfirm: r });
      else if (r.status === 'succeeded') useUi.getState().toast('success', r.message);
      else if (r.status !== 'cancelled') useUi.getState().toast('error', r.failure ? `${r.message} — ${r.failure.hint}` : r.message);
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
    } finally {
      set({ flashing: false });
    }
  },
  setProgress(steps) {
    set({ steps });
  },
  finished(r) {
    set({ last: r, steps: r.steps });
    const ui = useUi.getState();
    if (r.status === 'succeeded') ui.toast('success', `Build succeeded in ${(r.durationMs / 1000).toFixed(1)} s`);
    else if (r.status === 'blocked' || r.status === 'failed') {
      ui.toast('error', r.message);
      if (r.diagnostics.some((d) => d.severity === 'error')) ui.showBottom('problems');
    }
  },
}));

/* -------------------------------- serial -------------------------------- */

const UI_MAX_LINES = 20000;

/** Mutable ring outside React state; components re-render on `version`. */
export const serialBuffer = {
  lines: [] as SerialLine[],
  partial: '',
};

export const plotter = { parser: new TelemetryParser(), series: new SeriesBuffer(2000) };

interface SerialState {
  status: SerialStatus;
  version: number;
  paused: boolean;
  autoscroll: boolean;
  timestamps: boolean;
  filter: string;
  filterRegex: boolean;
  lineEnding: LineEnding;
  baud: number;
  plotPaused: boolean;
  plotVersion: number;
  append(lines: SerialLine[], partial: string): void;
  clear(): void;
  set(patch: Partial<Pick<SerialState, 'paused' | 'autoscroll' | 'timestamps' | 'filter' | 'filterRegex' | 'lineEnding' | 'baud' | 'plotPaused'>>): void;
  setStatus(s: SerialStatus): void;
  open(): Promise<void>;
  close(): Promise<void>;
  send(text: string): Promise<void>;
  clearPlot(): void;
}

export const useSerial = create<SerialState>((set, get) => ({
  status: { open: false, port: null, baud: null, bytesIn: 0, bytesOut: 0, linesBuffered: 0, error: null },
  version: 0,
  paused: false,
  autoscroll: true,
  timestamps: true,
  filter: '',
  filterRegex: false,
  lineEnding: 'lf',
  baud: 115200,
  plotPaused: false,
  plotVersion: 0,
  append(lines, partial) {
    if (!get().plotPaused) {
      let any = false;
      for (const l of lines) {
        const sample = plotter.parser.parse(l.text);
        if (sample) {
          plotter.series.push(l.t, sample);
          any = true;
        }
      }
      if (any) set((s) => ({ plotVersion: s.plotVersion + 1 }));
    }
    serialBuffer.partial = partial;
    if (get().paused) return;
    serialBuffer.lines.push(...lines);
    if (serialBuffer.lines.length > UI_MAX_LINES) serialBuffer.lines.splice(0, serialBuffer.lines.length - UI_MAX_LINES);
    set((s) => ({ version: s.version + 1 }));
  },
  clear() {
    serialBuffer.lines = [];
    serialBuffer.partial = '';
    void call('serial.clear');
    set((s) => ({ version: s.version + 1 }));
  },
  set(patch) {
    set(patch);
  },
  setStatus(status) {
    const prev = get().status;
    set({ status });
    if (prev.open && !status.open && status.error) useUi.getState().toast('warning', `Serial: ${status.error}`);
  },
  async open() {
    const port = useDevices.getState().selectedPort;
    if (!port) {
      useUi.getState().toast('warning', 'Select a port first');
      return;
    }
    try {
      get().setStatus(await call('serial.open', { port, baud: get().baud, autoReconnect: true }));
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
    }
  },
  async close() {
    get().setStatus(await call('serial.close'));
  },
  async send(text) {
    try {
      await call('serial.write', { data: text, lineEnding: get().lineEnding });
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
    }
  },
  clearPlot() {
    plotter.series.clear();
    plotter.parser.reset();
    set((s) => ({ plotVersion: s.plotVersion + 1 }));
  },
}));

/* ---------------------------------- AI ---------------------------------- */

interface AiState {
  status: AiStatus | null;
  history: ChatTurn[];
  busy: string | null;
  proposals: Proposal[];
  exclude: string[];
  load(): Promise<void>;
  run(label: string, fn: () => Promise<ChatTurn>): Promise<ChatTurn | null>;
  setProposals(p: Proposal[]): void;
  toggleExclude(id: string): void;
}

export const useAi = create<AiState>((set, get) => ({
  status: null,
  history: [],
  busy: null,
  proposals: [],
  exclude: [],
  async load() {
    const [status, history, proposals] = await Promise.all([call('ai.status'), call('ai.history'), call('proposals.list')]);
    set({ status, history, proposals });
  },
  async run(label, fn) {
    if (get().busy) return null;
    set({ busy: label });
    useUi.getState().setLayout({ copilotOpen: true });
    try {
      await fn();
      set({ history: await call('ai.history') });
      const last = get().history.at(-1) ?? null;
      if (last?.proposalId) useUi.getState().openTab({ id: `proposal:${last.proposalId}`, kind: 'proposal', title: 'Review changes', proposalId: last.proposalId });
      return last;
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
      return null;
    } finally {
      set({ busy: null });
    }
  },
  setProposals(proposals) {
    set({ proposals });
  },
  toggleExclude(id) {
    set((s) => ({ exclude: s.exclude.includes(id) ? s.exclude.filter((x) => x !== id) : [...s.exclude, id] }));
  },
}));

/* ------------------------------- processes ------------------------------ */

interface ProcState {
  processes: ProcessRecord[];
  output: Record<string, string>;
  logs: LogEntry[];
  started(r: ProcessRecord): void;
  exited(r: ProcessRecord): void;
  out(id: string, text: string): void;
  log(e: LogEntry): void;
}

export const useProcesses = create<ProcState>((set) => ({
  processes: [],
  output: {},
  logs: [],
  started(r) {
    set((s) => ({ processes: [r, ...s.processes].slice(0, 100) }));
  },
  exited(r) {
    set((s) => ({ processes: s.processes.map((p) => (p.id === r.id ? r : p)) }));
  },
  out(id, text) {
    set((s) => {
      const prev = s.output[id] ?? '';
      const next = (prev + text).slice(-200_000);
      return { output: { ...s.output, [id]: next } };
    });
  },
  log(e) {
    set((s) => ({ logs: [...s.logs.slice(-999), e] }));
  },
}));
