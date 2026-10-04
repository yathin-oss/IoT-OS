import { Unplug } from 'lucide-react';
import { useMemo } from 'react';
import { buildGraph, findBoardGpio } from '../../../core/circuit/graph';
import { disconnect, disconnectEndpoint, reassignBoardPin, renameComponent, setComponentProps } from '../../../core/circuit/operations';
import type { Diagnostic } from '../../../core/diagnostics';
import { BOARD_NODE, type PropValue } from '../../../core/project/schema';
import { getRegistry, isGpio } from '../../../core/registry/registry';
import type { PropDefinition } from '../../../core/registry/types';
import { useCircuit } from '../../state/circuit';
import { useUi } from '../../state/ui';
import { SeverityIcon } from '../panels/SeverityIcon';
import { useSim } from './simStore';

function DiagList({ diags }: { diags: Diagnostic[] }) {
  if (!diags.length) return <div className="faint" style={{ padding: '4px 12px' }}>No problems.</div>;
  return (
    <>
      {diags.map((d, i) => (
        <div key={i} className="list-row click selectable" style={{ alignItems: 'flex-start', fontSize: 12 }} onClick={() => d.target?.componentId && useCircuit.getState().select([d.target.componentId])}>
          <SeverityIcon severity={d.severity} />
          <div>
            {d.message}
            {d.hint && <div className="muted">{d.hint}</div>}
          </div>
        </div>
      ))}
    </>
  );
}

function PropInput({ def, value, onChange, disabled }: { def: PropDefinition; value: PropValue | undefined; onChange: (v: PropValue) => void; disabled?: boolean }) {
  const v = value ?? def.default;
  if (def.type === 'boolean') return <input type="checkbox" checked={v === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
  if (def.type === 'enum')
    return (
      <select className="select" style={{ height: 22, width: '100%' }} value={String(v)} disabled={disabled} onChange={(e) => onChange(typeof def.default === 'number' ? Number(e.target.value) : e.target.value)}>
        {def.options?.map((o) => (
          <option key={String(o)}>{String(o)}</option>
        ))}
      </select>
    );
  if (def.type === 'number' && def.min !== undefined && def.max !== undefined && def.simulation)
    return (
      <div className="row">
        <input type="range" min={def.min} max={def.max} step={(def.max - def.min) / 100} value={Number(v)} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} style={{ flex: 1 }} />
        <span className="mono" style={{ width: 44, textAlign: 'right' }}>
          {Number(v).toFixed(def.max - def.min <= 2 ? 2 : 0)}
        </span>
      </div>
    );
  return (
    <input
      className="input"
      style={{ height: 22, width: '100%' }}
      type={def.type === 'number' ? 'number' : 'text'}
      defaultValue={String(v)}
      key={String(v)}
      disabled={disabled}
      onBlur={(e) => {
        const nv = def.type === 'number' ? Number(e.target.value) : e.target.value;
        if (nv !== v && !(def.type === 'number' && Number.isNaN(nv))) onChange(nv);
      }}
    />
  );
}

function BoardInspector({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const { hardware, setHardware, history } = useCircuit();
  const sim = useSim();
  const reg = getRegistry();
  const board = hardware ? reg.getBoard(hardware.boardId) : undefined;
  if (!hardware || !board) return null;
  const used = new Set(history?.present.wires.flatMap((w) => [w.from, w.to]).filter((e) => e.node === BOARD_NODE).map((e) => reg.resolveBoardPin(board.id, e.pin)?.id ?? e.pin));
  return (
    <>
      <div className="section-title">Board</div>
      <div style={{ padding: '0 12px' }} className="col">
        <select
          className="select"
          value={hardware.boardId}
          disabled={sim.running}
          onChange={(e) => {
            const nb = reg.getBoard(e.target.value)!;
            useUi.getState().setDialog({
              kind: 'confirm',
              title: 'Change board',
              message: `Change the target board to ${nb.name}? Wires to pins that do not exist on the new board will be flagged by validation. Save the circuit to apply.`,
              confirmLabel: 'Change board',
              onConfirm: () => setHardware({ ...hardware, boardId: nb.id, features: { wifi: hardware.features.wifi && nb.wifi, bluetooth: hardware.features.bluetooth && nb.bluetooth } }),
            });
          }}
        >
          {reg.listBoards().map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={hardware.features.wifi} disabled={sim.running} onChange={(e) => setHardware({ ...hardware, features: { ...hardware.features, wifi: e.target.checked } })} /> Firmware uses Wi-Fi
        </label>
        <label className="check">
          <input type="checkbox" checked={hardware.features.bluetooth} disabled={sim.running} onChange={(e) => setHardware({ ...hardware, features: { ...hardware.features, bluetooth: e.target.checked } })} /> Firmware uses Bluetooth
        </label>
      </div>
      <div className="kv">
        <span className="k">MCU</span>
        <span>{board.mcu}</span>
        <span className="k">Logic level</span>
        <span>
          {board.logicVoltage} V{board.fiveVoltTolerant ? ' (5 V tolerant)' : ''}
        </span>
        <span className="k">Simulation</span>
        <span>{board.simulation.mcuEmulator ? 'Firmware (AVR8js)' : 'Circuit-level'}</span>
      </div>
      {sim.running && sim.mode === 'circuit-only' && (
        <>
          <div className="section-title">Drive pins (manual)</div>
          <div style={{ padding: '0 12px 8px' }}>
            {board.pins
              .filter((p) => used.has(p.id))
              .map((p) => (
                <div key={p.id} className="row" style={{ marginBottom: 3 }}>
                  <span className="mono" style={{ width: 70 }}>
                    {p.label}
                  </span>
                  <select className="select grow" style={{ height: 22 }} defaultValue="input" onChange={(e) => {
                    const v = e.target.value;
                    sim.drivePin(p.id, v.startsWith('pwm') ? { pwmDuty: Number(v.slice(3)) / 100 } : (v as 'high'));
                  }}>
                    <option value="input">Input (hi-Z)</option>
                    <option value="input-pullup">Input pull-up</option>
                    {p.capabilities.includes('digital-out') && <option value="high">Output HIGH</option>}
                    {p.capabilities.includes('digital-out') && <option value="low">Output LOW</option>}
                    {p.capabilities.includes('pwm') && <option value="pwm25">PWM 25%</option>}
                    {p.capabilities.includes('pwm') && <option value="pwm50">PWM 50%</option>}
                  </select>
                  <span className="mono faint" style={{ width: 44, textAlign: 'right' }}>
                    {sim.snapshot?.pins[p.id]?.inputVolts != null ? `${sim.snapshot.pins[p.id]!.inputVolts!.toFixed(1)}V` : '—'}
                  </span>
                </div>
              ))}
            {used.size === 0 && <div className="faint">No board pins are wired.</div>}
          </div>
        </>
      )}
      <div className="section-title">Validation</div>
      <DiagList diags={diagnostics} />
    </>
  );
}

export function Inspector({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const { history, hardware, selection, apply, select } = useCircuit();
  const sim = useSim();
  const reg = getRegistry();
  const circuit = history?.present;
  const board = hardware ? reg.getBoard(hardware.boardId) : undefined;
  const graph = useMemo(() => (circuit && board ? buildGraph(circuit, board.id) : null), [circuit, board]);
  if (!circuit || !board || !graph) return null;

  const id = selection.length === 1 ? selection[0]! : null;
  const inst = id ? circuit.components.find((c) => c.id === id) : undefined;
  const wire = id ? circuit.wires.find((w) => w.id === id) : undefined;

  if (wire) {
    return (
      <>
        <div className="section-title">Wire {wire.id}</div>
        <div className="kv">
          <span className="k">From</span>
          <span className="mono">
            {wire.from.node}.{wire.from.pin}
          </span>
          <span className="k">To</span>
          <span className="mono">
            {wire.to.node}.{wire.to.pin}
          </span>
        </div>
        <div style={{ padding: '6px 12px' }}>
          <button
            className="btn sm danger"
            disabled={sim.running}
            onClick={() => {
              apply((c) => disconnect(c, [wire.id]));
              select([]);
            }}
          >
            Delete wire
          </button>
        </div>
      </>
    );
  }
  if (!inst) return <BoardInspector diagnostics={diagnostics} />;
  const def = reg.getComponent(inst.type);
  if (!def) return <div className="empty">Unknown component type {inst.type}</div>;
  const compDiags = diagnostics.filter((d) => d.target?.componentId === inst.id);
  const gpios = board.pins.filter((p) => !(p.flags ?? []).includes('internal'));
  const live = sim.stimuli[inst.id] ?? {};
  const simState = sim.snapshot?.components[inst.id];

  return (
    <>
      <div className="section-title">{def.name}</div>
      <div className="col" style={{ padding: '0 12px 6px' }}>
        <div className="row">
          <span className="muted" style={{ width: 60 }}>
            Label
          </span>
          <input className="input grow" style={{ height: 22 }} defaultValue={inst.label} key={inst.id + inst.label} disabled={sim.running} onBlur={(e) => e.target.value.trim() && e.target.value !== inst.label && apply((c) => renameComponent(c, inst.id, e.target.value))} />
        </div>
        <div className="faint" style={{ fontSize: 12 }}>
          {def.description}
        </div>
        {def.sim.notes && <div className="faint" style={{ fontSize: 11.5 }}>Simulation: {def.sim.notes}</div>}
      </div>

      {def.props.length > 0 && (
        <>
          <div className="section-title">Properties</div>
          <div style={{ padding: '0 12px 6px' }}>
            {def.props.map((p) => (
              <div key={p.key} style={{ marginBottom: 6 }}>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {p.label}
                  {p.unit ? ` (${p.unit})` : ''} {p.simulation && <span className="badge">sim</span>}
                </div>
                {p.simulation && sim.running ? (
                  <PropInput def={p} value={live[p.key] ?? inst.props[p.key]} onChange={(v) => sim.stimulus(inst.id, p.key, v)} />
                ) : (
                  <PropInput def={p} value={inst.props[p.key]} disabled={sim.running} onChange={(v) => apply((c) => setComponentProps(c, inst.id, { [p.key]: v }))} />
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {simState && (
        <>
          <div className="section-title">Live state</div>
          <div className="mono" style={{ padding: '0 12px 6px', fontSize: 12 }}>
            {JSON.stringify(simState)}
          </div>
        </>
      )}

      {def.pins.length > 0 && (
        <>
          <div className="section-title">Pins</div>
          <table className="table" style={{ margin: '0 4px' }}>
            <tbody>
              {def.pins.map((pin) => {
                const net = graph.netOf.get(`${inst.id}:${pin.id}`);
                const others = (net?.endpoints ?? []).filter((e) => e.key !== `${inst.id}:${pin.id}`);
                const viaGpio = findBoardGpio(graph, inst.id, pin.id);
                const directBoard = circuit.wires.find((w) => (w.from.node === inst.id && w.from.pin === pin.id && w.to.node === BOARD_NODE) || (w.to.node === inst.id && w.to.pin === pin.id && w.from.node === BOARD_NODE));
                const directPin = directBoard ? (directBoard.from.node === BOARD_NODE ? directBoard.from.pin : directBoard.to.pin) : '';
                const options = pin.role === 'power' ? board.power.filter((p) => p.kind === 'power') : pin.role === 'ground' ? board.power.filter((p) => p.kind === 'ground') : gpios;
                return (
                  <tr key={pin.id}>
                    <td style={{ width: 54 }}>
                      <b>{pin.id}</b>
                      <div className="faint" style={{ fontSize: 10.5 }}>
                        {pin.role}
                        {pin.requires ? ` · ${pin.requires.join('+')}` : ''}
                      </div>
                    </td>
                    <td>
                      <select
                        className="select"
                        style={{ height: 22, width: '100%' }}
                        value={directPin ? (reg.resolveBoardPin(board.id, directPin)?.id ?? directPin) : ''}
                        disabled={sim.running}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (!v) apply((c) => disconnectEndpoint(c, { node: inst.id, pin: pin.id }));
                          else apply((c) => reassignBoardPin(c, inst.id, pin.id, v));
                        }}
                        title="Board pin (direct wire)"
                      >
                        <option value="">{others.length ? '— (via other part)' : '— not connected'}</option>
                        {options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                            {isGpio(o) && o.flags?.length ? ` [${o.flags.join(',')}]` : ''}
                          </option>
                        ))}
                      </select>
                      {others.length > 0 && (
                        <div className="faint" style={{ fontSize: 10.5 }}>
                          ↔ {others.map((o) => (o.kind === 'component' ? `${o.instance.label}.${o.pin.id}` : o.kind === 'invalid' ? o.key : o.pin.label)).join(', ')}
                          {viaGpio?.via ? ` · reaches ${viaGpio.pin.label} via ${viaGpio.via}` : ''}
                        </div>
                      )}
                    </td>
                    <td style={{ width: 24 }}>
                      {others.length > 0 && (
                        <button className="icon-btn" title="Disconnect pin" disabled={sim.running} onClick={() => apply((c) => disconnectEndpoint(c, { node: inst.id, pin: pin.id }))}>
                          <Unplug size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      <div className="section-title">Validation</div>
      <DiagList diags={compDiags} />
    </>
  );
}
