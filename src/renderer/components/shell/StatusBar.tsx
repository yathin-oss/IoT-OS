import { AlertTriangle, Bot, CircleX, Cpu, Hammer, Plug, Radio } from 'lucide-react';
import { useMemo } from 'react';
import { getRegistry } from '../../../core/registry/registry';
import { LANGUAGE_LABELS } from '../../../core/registry/types';
import { runCommand } from '../../commands';
import { useEditor } from '../../state/editor';
import { useProject } from '../../state/project';
import { useAi, useBuild, useDevices, useSerial } from '../../state/runtime';
import { useUi } from '../../state/ui';
import { useAllProblems } from '../panels/problems';

export function StatusBar() {
  const snapshot = useProject((s) => s.snapshot);
  const problems = useAllProblems();
  const { running, flashing, last, flashProgress } = useBuild();
  const { devices, selectedPort } = useDevices();
  const serial = useSerial((s) => s.status);
  const ai = useAi((s) => s.status);
  const aiBusy = useAi((s) => s.busy);
  const cursor = useEditor((s) => s.cursor);
  const ui = useUi();
  const counts = useMemo(() => {
    let e = 0;
    let w = 0;
    for (const p of problems) {
      if (p.severity === 'error' || p.severity === 'blocking') e++;
      else if (p.severity === 'warning') w++;
    }
    return { e, w };
  }, [problems]);
  const board = snapshot ? getRegistry().getBoard(snapshot.hardware.boardId) : undefined;
  const dev = devices.find((d) => d.port === selectedPort);

  if (!snapshot) {
    return (
      <div className="statusbar no-project">
        <span className="item">No project open</span>
        <span className="spacer" />
        <span className="item click" onClick={() => runCommand('setup.open')}>
          Setup check
        </span>
        <span className="item">
          <Bot size={12} /> {ai?.configured ? ai.model : 'AI not configured'}
        </span>
      </div>
    );
  }
  return (
    <div className="statusbar">
      <span className="item click" onClick={() => ui.showBottom('problems')} title="Problems" data-testid="status-problems">
        <CircleX size={12} /> {counts.e} <AlertTriangle size={12} /> {counts.w}
      </span>
      <span className="item click" onClick={() => ui.setActivity('devices')} title="Target board">
        <Cpu size={12} /> {board?.name ?? snapshot.hardware.boardId}
      </span>
      <span className="item click" onClick={() => ui.setActivity('devices')} title="Port / device state">
        <Plug size={12} /> {selectedPort ? `${selectedPort.replace('/dev/', '')} · ${dev?.state ?? '—'}` : 'No device'}
      </span>
      <span className="item click" onClick={() => runCommand('serial.open')} title="Serial">
        <Radio size={12} /> {serial.open ? `${serial.baud} baud` : 'Serial closed'}
      </span>
      <span className="item">{LANGUAGE_LABELS[snapshot.manifest.language]}</span>
      <span className="item click" onClick={() => ui.showBottom('build')} title="Build state">
        <Hammer size={12} />
        {running ? 'Building…' : flashing ? `Uploading ${flashProgress?.percent != null ? `${flashProgress.percent}%` : '…'}` : last ? `Build ${last.status}` : 'Not built'}
      </span>
      <span className="spacer" />
      {cursor && (
        <span className="item">
          Ln {cursor.line}, Col {cursor.column}
        </span>
      )}
      <span className="item click" onClick={() => runCommand('ai.ask')} title={ai?.message}>
        <Bot size={12} /> {aiBusy ? `${aiBusy}…` : ai?.configured ? ai.model : 'AI not configured'}
      </span>
    </div>
  );
}
