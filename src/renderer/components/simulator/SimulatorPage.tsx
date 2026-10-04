import { Bot, Play, Redo2, RotateCw, Save, Square, Trash2, Undo2, Copy, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { disconnect, duplicateComponents, removeComponents, rotateComponent } from '../../../core/circuit/operations';
import { BOARD_NODE } from '../../../core/project/schema';
import { getRegistry } from '../../../core/registry/registry';
import { validateHardware } from '../../../core/validation/engine';
import { call } from '../../api/client';
import { useCircuit } from '../../state/circuit';
import { useAi } from '../../state/runtime';
import { useUi } from '../../state/ui';
import { CircuitCanvas } from './CircuitCanvas';
import { Inspector } from './Inspector';
import { useSim } from './simStore';

function SimSerial() {
  const { serial, sendSerial, mode } = useSim();
  const [input, setInput] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [serial]);
  return (
    <div style={{ height: 140, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flex: 'none' }}>
      <div className="toolbar" style={{ height: 26 }}>
        <span className="muted" style={{ fontSize: 11 }}>
          SIMULATED SERIAL (USART0)
        </span>
        <span className="spacer" />
        <input className="input mono" style={{ height: 20, width: 220 }} disabled={mode !== 'mcu'} placeholder={mode === 'mcu' ? 'Send to simulated MCU' : 'MCU not emulated'} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => {
          if (e.key === 'Enter') {
            sendSerial(input + '\n');
            setInput('');
          }
        }} />
      </div>
      <div className="console" ref={box} data-testid="sim-serial">
        {serial || <span className="faint">{mode === 'mcu' ? 'Waiting for Serial output…' : '—'}</span>}
      </div>
    </div>
  );
}

export function SimulatorPage() {
  const { history, hardware, selection, apply, undo, redo, save, revert, dirty, select } = useCircuit();
  const sim = useSim();
  const ui = useUi();
  const isDirty = dirty();
  const diagnostics = useMemo(() => (history && hardware ? validateHardware(hardware, history.present).diagnostics : []), [history, hardware]);
  const board = hardware ? getRegistry().getBoard(hardware.boardId) : undefined;
  const ids = selection.filter((s) => s !== BOARD_NODE && history?.present.components.some((c) => c.id === s));
  useEffect(() => () => useSim.getState().stop(), []);
  // Stop the simulation when the circuit is edited so it never shows stale behaviour.
  const present = history?.present;
  const startedWith = useRef(present);
  useEffect(() => {
    if (sim.running && present !== startedWith.current) {
      sim.stop();
      ui.toast('info', 'Simulation stopped because the circuit changed. Press Run to restart.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present]);

  if (!history || !hardware || !board) {
    return (
      <div className="empty">
        <h4>No project open</h4>Open or create a project to design and simulate its circuit.
      </div>
    );
  }
  const errors = diagnostics.filter((d) => d.severity === 'error' || d.severity === 'blocking').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
  return (
    <>
      <div className="toolbar" style={{ background: 'var(--bg-2)' }}>
        {sim.running ? (
          <button className="btn sm danger" onClick={() => sim.stop()}>
            <Square size={12} /> Stop
          </button>
        ) : (
          <button
            className="btn sm primary"
            onClick={() => {
              startedWith.current = history.present;
              void sim.start();
            }}
            data-testid="sim-run"
          >
            <Play size={12} /> Run
          </button>
        )}
        <select className="select" style={{ height: 22 }} value={sim.speed} onChange={(e) => sim.setSpeed(Number(e.target.value))} title="Simulation speed">
          {[0.25, 0.5, 1, 2].map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <div style={{ width: 8 }} />
        <button className="icon-btn" title="Undo (⌘/Ctrl+Z)" disabled={history.past.length === 0 || sim.running} onClick={undo}>
          <Undo2 size={14} />
        </button>
        <button className="icon-btn" title="Redo (⌘/Ctrl+Shift+Z)" disabled={history.future.length === 0 || sim.running} onClick={redo}>
          <Redo2 size={14} />
        </button>
        <button className="icon-btn" title="Rotate (R)" disabled={ids.length === 0 || sim.running} onClick={() => apply((c) => ids.reduce((a, id) => rotateComponent(a, id), c))}>
          <RotateCw size={14} />
        </button>
        <button
          className="icon-btn"
          title="Duplicate (⌘/Ctrl+D)"
          disabled={ids.length === 0 || sim.running}
          onClick={() => {
            let n: string[] = [];
            apply((c) => {
              const r = duplicateComponents(c, ids);
              n = Object.values(r.idMap);
              return r.circuit;
            });
            select(n);
          }}
        >
          <Copy size={14} />
        </button>
        <button
          className="icon-btn"
          title="Delete (Del)"
          disabled={selection.length === 0 || selection.includes(BOARD_NODE) || sim.running}
          onClick={() => {
            const wires = selection.filter((s) => history.present.wires.some((w) => w.id === s));
            apply((c) => disconnect(removeComponents(c, ids), wires));
            select([]);
          }}
        >
          <Trash2 size={14} />
        </button>
        <div style={{ width: 8 }} />
        <button className="btn sm" disabled={!isDirty} onClick={() => void save()} data-testid="circuit-save">
          <Save size={12} /> Save circuit
        </button>
        <button className="btn sm ghost" disabled={!isDirty} onClick={revert}>
          <RotateCcw size={12} /> Revert
        </button>
        <span className="spacer" />
        <span className={`badge ${errors ? 'err' : warnings ? 'warn' : 'ok'}`} style={{ cursor: 'pointer' }} onClick={() => ui.showBottom('problems')}>
          {errors} errors · {warnings} warnings
        </span>
        <button
          className="btn sm ghost"
          title="Ask the AI to modify the circuit (creates a validated, reviewable proposal)"
          onClick={() =>
            ui.setDialog({
              kind: 'prompt',
              title: 'Modify circuit with AI',
              label: 'What should change? (e.g. "add a DHT22 on a free pin")',
              initial: '',
              onSubmit: (request) => void useAi.getState().run('Designing circuit', () => call('ai.planCircuit', { request })),
            })
          }
        >
          <Bot size={12} /> AI circuit
        </button>
      </div>
      {sim.running && (
        <div className="editor-banner" style={{ background: sim.mode === 'mcu' ? '#14243b' : '#3d3112', color: sim.mode === 'mcu' ? '#b9d6ff' : '#f3d98b', borderColor: 'var(--border)' }}>
          <span className="grow">
            {sim.mode === 'mcu' ? `Running firmware on emulated ${board.mcu}` : 'Circuit-level simulation (firmware not executed)'}
            {sim.firmwareInfo ? ` — ${sim.firmwareInfo}` : ''}
          </span>
          {sim.snapshot?.speed != null && <span className="mono">{sim.snapshot.speed >= 0.95 ? 'real time' : `${Math.round(sim.snapshot.speed * 100)}% of real time`}</span>}
          <span className="mono">t = {((sim.snapshot?.timeMs ?? 0) / 1000).toFixed(1)} s</span>
        </div>
      )}
      <div className="sim">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <CircuitCanvas diagnostics={diagnostics} />
          {sim.running && sim.mode === 'mcu' && <SimSerial />}
        </div>
        <div className="sim-inspector">
          <Inspector diagnostics={diagnostics} />
        </div>
      </div>
    </>
  );
}
