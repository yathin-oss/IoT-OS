import { X } from 'lucide-react';
import { useSerial } from '../../state/runtime';
import { useUi, type BottomTab } from '../../state/ui';
import { BuildPanel } from '../panels/BuildPanel';
import { OutputPanel } from '../panels/OutputPanel';
import { PlotterPanel } from '../panels/PlotterPanel';
import { ProblemsPanel } from '../panels/ProblemsPanel';
import { useAllProblems } from '../panels/problems';
import { SerialPanel } from '../panels/SerialPanel';
import { TerminalPanel } from '../panels/TerminalPanel';

const TABS: { id: BottomTab; label: string }[] = [
  { id: 'problems', label: 'Problems' },
  { id: 'build', label: 'Build' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'serial', label: 'Serial Monitor' },
  { id: 'plotter', label: 'Plotter' },
  { id: 'output', label: 'Output' },
];

export function BottomPanel() {
  const { bottomTab, showBottom, setLayout } = useUi();
  const problems = useAllProblems().filter((p) => p.severity !== 'info').length;
  const serialOpen = useSerial((s) => s.status.open);
  return (
    <>
      <div className="bottom-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`bottom-tab${bottomTab === t.id ? ' active' : ''}`} onClick={() => showBottom(t.id)} data-testid={`panel-${t.id}`}>
            {t.label}
            {t.id === 'problems' && problems > 0 && <span className="badge">{problems}</span>}
            {t.id === 'serial' && serialOpen && <span className="badge ok">live</span>}
          </button>
        ))}
        <span className="spacer" />
        <button className="icon-btn" onClick={() => setLayout({ bottomOpen: false })} title="Close panel">
          <X size={14} />
        </button>
      </div>
      <div className="bottom-body">
        {bottomTab === 'problems' && <ProblemsPanel />}
        {bottomTab === 'build' && <BuildPanel />}
        {bottomTab === 'terminal' && <TerminalPanel />}
        {bottomTab === 'serial' && <SerialPanel />}
        {bottomTab === 'plotter' && <PlotterPanel />}
        {bottomTab === 'output' && <OutputPanel />}
      </div>
    </>
  );
}
