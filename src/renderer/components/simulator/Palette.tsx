import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { addComponent } from '../../../core/circuit/operations';
import { getRegistry } from '../../../core/registry/registry';
import type { ComponentCategory } from '../../../core/registry/types';
import { boardSimulationMatrix, componentSimulationMatrix } from '../../../core/sim/capabilities';
import { useCircuit } from '../../state/circuit';
import { useProject } from '../../state/project';
import { useUi } from '../../state/ui';
import { PALETTE_MIME } from './CircuitCanvas';
import { useSim } from './simStore';

const CATEGORIES: { id: ComponentCategory; label: string }[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'input', label: 'Input' },
  { id: 'sensor', label: 'Sensors' },
  { id: 'display', label: 'Displays' },
  { id: 'actuator', label: 'Actuators' },
  { id: 'communication', label: 'Communication' },
  { id: 'layout', label: 'Layout' },
];

export function SimulatorSideView() {
  const hasProject = useProject((s) => s.snapshot !== null);
  const { apply, select, history } = useCircuit();
  const running = useSim((s) => s.running);
  const [q, setQ] = useState('');
  const [showMatrix, setShowMatrix] = useState(false);
  const comps = useMemo(() => getRegistry().listComponents().filter((c) => !q || `${c.name} ${c.description} ${c.type}`.toLowerCase().includes(q.toLowerCase())), [q]);
  if (!hasProject) return <div className="empty">Open a project to use the simulator.</div>;
  const add = (type: string) => {
    if (running) return;
    useUi.getState().openTab({ id: 'simulator', kind: 'simulator', title: 'Simulator' });
    const n = history?.present.components.length ?? 0;
    let id = '';
    apply((c) => {
      const r = addComponent(c, type, { x: 360 + (n % 4) * 30, y: 40 + (n % 6) * 30 });
      id = r.id;
      return r.circuit;
    });
    select([id]);
  };
  const simSupport = new Map(componentSimulationMatrix().map((m) => [m.type, m]));
  return (
    <>
      <div className="sidebar-head">Components</div>
      <div style={{ padding: '0 10px 8px' }}>
        <input className="input" style={{ width: '100%' }} placeholder="Search components" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="sidebar-body">
        {CATEGORIES.map((cat) => {
          const items = comps.filter((c) => c.category === cat.id);
          if (!items.length) return null;
          return (
            <div key={cat.id}>
              <div className="section-title">{cat.label}</div>
              {items.map((c) => (
                <div
                  key={c.type}
                  className="palette-item"
                  draggable={!running}
                  onDragStart={(e) => e.dataTransfer.setData(PALETTE_MIME, c.type)}
                  onDoubleClick={() => add(c.type)}
                  title={`${c.description}\nDrag onto the canvas or double-click to add.`}
                  data-testid={`palette-${c.type}`}
                >
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: c.visual.color ?? (c.visual.shape === 'led' ? '#ff4d4d' : '#888'), flex: 'none' }} />
                  <span className="grow ellipsis">{c.name}</span>
                  {simSupport.get(c.type)?.supported === false && c.electrical && (
                    <span className="badge" title={simSupport.get(c.type)?.notes}>
                      no sim
                    </span>
                  )}
                  <button className="icon-btn" onClick={() => add(c.type)} title="Add" disabled={running}>
                    <Plus size={12} />
                  </button>
                </div>
              ))}
            </div>
          );
        })}
        <div className="divider" />
        <div className="list-row click" onClick={() => setShowMatrix(!showMatrix)}>
          {showMatrix ? '▾' : '▸'} Simulation capability matrix
        </div>
        {showMatrix && (
          <div style={{ padding: '0 12px 12px', fontSize: 11.5 }}>
            {boardSimulationMatrix().map((b) => (
              <div key={b.boardId} style={{ marginBottom: 4 }}>
                <span className={`badge ${b.firmware ? 'ok' : ''}`}>{b.firmware ? 'firmware' : 'circuit'}</span> {b.boardName}
              </div>
            ))}
            <div className="faint" style={{ marginTop: 6 }}>
              Firmware-level boards run your compiled code (GPIO, PWM, timers, ADC, Serial). Others support circuit-level simulation with manual pin driving.
            </div>
          </div>
        )}
      </div>
    </>
  );
}
