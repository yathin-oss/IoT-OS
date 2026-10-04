import { call, errorMessage } from './api/client';
import { useCircuit } from './state/circuit';
import { useEditor } from './state/editor';
import { useProject } from './state/project';
import { useAi, useApp, useBuild, useDevices, useSerial } from './state/runtime';
import { useUi } from './state/ui';

export interface Command {
  id: string;
  title: string;
  category: 'Project' | 'File' | 'Build' | 'Device' | 'Serial' | 'Libraries' | 'Drivers' | 'Simulator' | 'AI' | 'Docs' | 'View' | 'Help';
  keys?: string;
  /** Requires an open project. */
  needsProject?: boolean;
  run(): void | Promise<void>;
}

const ui = () => useUi.getState();
const hasProject = () => useProject.getState().snapshot !== null;

export async function openProjectFlow(): Promise<void> {
  const info = useApp.getState().info;
  if (info?.canPickDirectories) {
    const dir = await call('app.pickDirectory', { title: 'Open IoT-OS project folder' });
    if (dir) await useProject.getState().open(dir);
  } else ui().setDialog({ kind: 'open-project' });
}

async function proposal(fn: () => Promise<{ id: string } | null>, none: string): Promise<void> {
  try {
    const p = await fn();
    if (p) ui().openTab({ id: `proposal:${p.id}`, kind: 'proposal', title: 'Review changes', proposalId: p.id });
    else ui().toast('info', none);
  } catch (err) {
    ui().toast('error', errorMessage(err));
  }
}

export function activeFilePath(): string | undefined {
  const s = ui();
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  return tab?.kind === 'file' ? tab.path : undefined;
}

export function contextOptions() {
  const path = activeFilePath();
  const file = path ? useEditor.getState().files[path] : undefined;
  return { exclude: useAi.getState().exclude as never[], ...(path ? { activeFile: path } : {}), ...(file ? { activeContent: file.content } : {}) };
}

export const COMMANDS: Command[] = [
  { id: 'project.new', title: 'Create Project…', category: 'Project', run: () => ui().setDialog({ kind: 'new-project' }) },
  { id: 'project.open', title: 'Open Project…', category: 'Project', run: openProjectFlow },
  { id: 'project.ai', title: 'Build Project with AI…', category: 'AI', run: () => ui().setDialog({ kind: 'ai-builder', idea: '' }) },
  { id: 'project.close', title: 'Close Project', category: 'Project', needsProject: true, run: () => useProject.getState().close() },
  { id: 'project.home', title: 'Show Home / Project Gallery', category: 'Project', run: () => ui().openTab({ id: 'home', kind: 'home', title: 'Home' }) },
  { id: 'file.save', title: 'Save File', category: 'File', keys: 'Mod+S', needsProject: true, run: async () => {
      const path = activeFilePath();
      if (path) await useEditor.getState().save(path);
      else if (ui().activeTabId === 'simulator' && useCircuit.getState().dirty()) await useCircuit.getState().save();
    } },
  { id: 'file.saveAll', title: 'Save All', category: 'File', keys: 'Mod+Alt+S', needsProject: true, run: async () => {
      await useEditor.getState().saveAll();
      if (useCircuit.getState().dirty()) await useCircuit.getState().save();
    } },
  { id: 'build.run', title: 'Build', category: 'Build', keys: 'Mod+Shift+B', needsProject: true, run: async () => {
      await useEditor.getState().saveAll();
      if (useCircuit.getState().dirty()) await useCircuit.getState().save();
      await useBuild.getState().build();
    } },
  { id: 'build.upload', title: 'Upload to Board', category: 'Build', keys: 'Mod+U', needsProject: true, run: () => useBuild.getState().upload() },
  { id: 'build.buildUpload', title: 'Build and Upload', category: 'Build', needsProject: true, run: async () => {
      await useEditor.getState().saveAll();
      const r = await useBuild.getState().build();
      if (r?.status === 'succeeded') await useBuild.getState().upload();
    } },
  { id: 'build.cancel', title: 'Cancel Build / Upload', category: 'Build', run: async () => {
      await call('build.cancel');
      await call('flash.cancel');
    } },
  { id: 'device.connect', title: 'Connect Device', category: 'Device', run: async () => {
      ui().setActivity('devices');
      await useDevices.getState().refresh();
    } },
  { id: 'serial.open', title: 'Open Serial Monitor', category: 'Serial', keys: 'Mod+Shift+M', run: async () => {
      ui().showBottom('serial');
      if (!useSerial.getState().status.open) await useSerial.getState().open();
    } },
  { id: 'serial.close', title: 'Close Serial Port', category: 'Serial', run: () => useSerial.getState().close() },
  { id: 'serial.plotter', title: 'Open Serial Plotter', category: 'Serial', run: () => ui().showBottom('plotter') },
  { id: 'library.install', title: 'Install Library…', category: 'Libraries', run: () => ui().setActivity('libraries') },
  { id: 'driver.install', title: 'Install / Diagnose USB Drivers', category: 'Drivers', run: () => ui().setActivity('drivers') },
  { id: 'sim.open', title: 'Open Simulator', category: 'Simulator', needsProject: true, run: () => ui().setActivity('simulator') },
  { id: 'pins.sync', title: 'Sync Pin Configuration from Circuit', category: 'Project', needsProject: true, run: () => proposal(() => call('project.syncPins'), 'Firmware pin configuration already matches the circuit.') },
  { id: 'docs.wiring', title: 'Generate Wiring Guide', category: 'Docs', needsProject: true, run: () => proposal(() => call('project.generateDocs', { kind: 'hardware' }), 'docs/HARDWARE.md is already up to date.') },
  { id: 'docs.hardware', title: 'Generate Hardware List', category: 'Docs', needsProject: true, run: () => proposal(() => call('project.generateDocs', { kind: 'hardware' }), 'docs/HARDWARE.md is already up to date.') },
  { id: 'docs.setup', title: 'Generate Setup Guide', category: 'Docs', needsProject: true, run: () => proposal(() => call('project.generateDocs', { kind: 'setup' }), 'docs/SETUP.md is already up to date.') },
  { id: 'ai.ask', title: 'Ask Copilot', category: 'AI', keys: 'Mod+L', run: () => {
      ui().setLayout({ copilotOpen: true });
      setTimeout(() => document.getElementById('copilot-input')?.focus(), 30);
    } },
  { id: 'ai.generateFirmware', title: 'Generate Firmware from Circuit', category: 'AI', needsProject: true, run: () =>
      void useAi.getState().run('Generating firmware', () =>
        call('ai.editCode', {
          instruction: 'Generate complete, working firmware for this project based on the current circuit and its pin configuration. Initialise every connected component, read sensors periodically and print values as name:value pairs for the plotter.',
          options: contextOptions(),
        }),
      ) },
  { id: 'ai.fixError', title: 'Fix Build Error with AI', category: 'AI', needsProject: true, run: () => void useAi.getState().run('Analysing build', () => call('ai.fixBuild', { options: contextOptions() })) },
  { id: 'ai.debugSerial', title: 'Debug Serial Output with AI', category: 'AI', needsProject: true, run: () => void useAi.getState().run('Analysing serial output', () => call('ai.debugSerial', { options: contextOptions() })) },
  { id: 'ai.explainFile', title: 'Explain Current File', category: 'AI', needsProject: true, run: () => {
      const path = activeFilePath();
      if (!path) return ui().toast('info', 'Open a source file first');
      void useAi.getState().run('Explaining', () => call('ai.explain', { subject: `the file ${path}`, options: contextOptions() }));
    } },
  { id: 'setup.open', title: 'Environment Setup Check', category: 'Help', run: () => ui().openTab({ id: 'setup', kind: 'setup', title: 'Setup' }) },
  { id: 'settings.open', title: 'Open Settings', category: 'View', keys: 'Mod+,', run: () => ui().openTab({ id: 'settings', kind: 'settings', title: 'Settings' }) },
  { id: 'view.sidebar', title: 'Toggle Side Bar', category: 'View', keys: 'Mod+B', run: () => ui().setLayout({ sidebarOpen: !ui().sidebarOpen }) },
  { id: 'view.panel', title: 'Toggle Panel', category: 'View', keys: 'Mod+J', run: () => ui().setLayout({ bottomOpen: !ui().bottomOpen }) },
  { id: 'view.copilot', title: 'Toggle Copilot', category: 'View', keys: 'Mod+Alt+B', run: () => ui().setLayout({ copilotOpen: !ui().copilotOpen }) },
  { id: 'view.problems', title: 'Show Problems', category: 'View', keys: 'Mod+Shift+O', run: () => ui().showBottom('problems') },
  { id: 'view.terminal', title: 'Show Terminal (tool processes)', category: 'View', run: () => ui().showBottom('terminal') },
  { id: 'help.diagnostics', title: 'Export Diagnostics Bundle', category: 'Help', run: async () => {
      try {
        const r = await call('app.exportDiagnostics');
        ui().toast('success', `Diagnostics written to ${r.path}`);
      } catch (err) {
        ui().toast('error', errorMessage(err));
      }
    } },
];

export function runCommand(id: string): void {
  const cmd = COMMANDS.find((c) => c.id === id);
  if (!cmd) return;
  if (cmd.needsProject && !hasProject()) {
    ui().toast('info', 'Open or create a project first');
    return;
  }
  void Promise.resolve(cmd.run()).catch((err: unknown) => ui().toast('error', errorMessage(err)));
}

function matches(e: KeyboardEvent, keys: string): boolean {
  const parts = keys.split('+');
  const key = parts.pop()!.toLowerCase();
  const mod = parts.includes('Mod');
  const isMac = navigator.platform.toLowerCase().includes('mac');
  return (
    e.key.toLowerCase() === key &&
    (!mod || (isMac ? e.metaKey : e.ctrlKey)) &&
    e.shiftKey === parts.includes('Shift') &&
    e.altKey === parts.includes('Alt')
  );
}

export function handleGlobalKey(e: KeyboardEvent): boolean {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
    ui().setPalette(true);
    return true;
  }
  for (const c of COMMANDS) {
    if (c.keys && matches(e, c.keys)) {
      runCommand(c.id);
      return true;
    }
  }
  return false;
}

export function displayKeys(keys: string): string {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  return keys.replace('Mod', isMac ? '⌘' : 'Ctrl').replace('Shift', isMac ? '⇧' : 'Shift').replace('Alt', isMac ? '⌥' : 'Alt').replaceAll('+', isMac ? '' : '+');
}
