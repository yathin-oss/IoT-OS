import { call, onEvent } from '../api/client';
import { useCircuit } from './circuit';
import { useEditor } from './editor';
import { useProject } from './project';
import { useAi, useApp, useBuild, useDevices, useProcesses, useSerial } from './runtime';
import { useUi } from './ui';

/** Routes backend events into stores. Called once at startup. */
export async function initState(): Promise<void> {
  onEvent('project.changed', (snap) => {
    useProject.getState().setSnapshot(snap);
    useCircuit.getState().sync();
  });
  onEvent('fs.changed', ({ paths, external }) => {
    void useProject.getState().refreshTree();
    if (external) void useEditor.getState().onDiskChange(paths);
    if (paths.some((p) => /^(src|include)\//.test(p))) void useProject.getState().refreshDiagnostics();
  });
  onEvent('devices.changed', (d) => useDevices.getState().setDevices(d));
  onEvent('serial.data', ({ lines, partial }) => useSerial.getState().append(lines, partial));
  onEvent('serial.status', (s) => useSerial.getState().setStatus(s));
  onEvent('build.progress', ({ steps }) => useBuild.getState().setProgress(steps));
  onEvent('flash.progress', (p) => useBuild.setState({ flashProgress: p }));
  onEvent('process.started', (r) => useProcesses.getState().started(r));
  onEvent('process.exited', (r) => useProcesses.getState().exited(r));
  onEvent('process.output', ({ id, text }) => useProcesses.getState().out(id, text));
  onEvent('proposals.changed', (p) => useAi.getState().setProposals(p));
  onEvent('log.entry', (e) => useProcesses.getState().log(e));

  await useApp.getState().load();
  useSerial.setState({ baud: useApp.getState().settings?.serial.defaultBaud ?? 115200, lineEnding: useApp.getState().settings?.serial.lineEnding ?? 'lf', timestamps: useApp.getState().settings?.serial.timestamps ?? true });
  const [current, devices, last, processes, serialStatus] = await Promise.all([call('project.current'), call('devices.list'), call('build.last'), call('process.list'), call('serial.status')]);
  useProject.getState().setSnapshot(current);
  useCircuit.getState().sync(true);
  useDevices.getState().setDevices(devices);
  useBuild.setState({ last, steps: last?.steps ?? [] });
  useProcesses.setState({ processes });
  useSerial.getState().setStatus(serialStatus);
  if (serialStatus.open) {
    const hist = await call('serial.history', { limit: 5000 });
    useSerial.getState().append(hist, '');
  }
  await Promise.all([useProject.getState().refreshList(), useAi.getState().load()]);
  void useDevices.getState().refresh();
  if (current) useUi.getState().setActivity('explorer');
}
