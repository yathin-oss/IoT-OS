import { CircuitBoard, FileText, GitCompare, Home, Settings, Stethoscope, X } from 'lucide-react';
import { useCircuit } from '../../state/circuit';
import { useEditor } from '../../state/editor';
import { useUi, type EditorTab } from '../../state/ui';
import { CodeEditor } from '../editor/CodeEditor';
import { HomePage } from '../pages/HomePage';
import { ProposalReview } from '../pages/ProposalReview';
import { SettingsPage } from '../pages/SettingsPage';
import { SetupPage } from '../pages/SetupPage';
import { SimulatorPage } from '../simulator/SimulatorPage';
import { ErrorBoundary } from './ErrorBoundary';

function TabIcon({ tab }: { tab: EditorTab }) {
  const p = { size: 13, className: 'muted' };
  switch (tab.kind) {
    case 'home':
      return <Home {...p} />;
    case 'simulator':
      return <CircuitBoard {...p} />;
    case 'settings':
      return <Settings {...p} />;
    case 'proposal':
      return <GitCompare {...p} />;
    case 'setup':
      return <Stethoscope {...p} />;
    default:
      return <FileText {...p} />;
  }
}

export function EditorArea() {
  const { tabs, activeTabId, setActiveTab, closeTab, setDialog } = useUi();
  const files = useEditor((s) => s.files);
  const circuitDirty = useCircuit((s) => s.history !== null && (s.history.present !== s.savedCircuit || s.hardware !== s.savedHardware));
  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0]!;

  const isDirty = (t: EditorTab) => (t.kind === 'file' && t.path ? files[t.path] !== undefined && files[t.path]!.content !== files[t.path]!.saved : t.kind === 'simulator' && circuitDirty);
  const close = (t: EditorTab) => {
    if (isDirty(t)) {
      setDialog({
        kind: 'confirm',
        title: 'Unsaved changes',
        message: `${t.title} has unsaved changes. Close and discard them?`,
        confirmLabel: 'Discard',
        danger: true,
        onConfirm: () => {
          if (t.path) useEditor.getState().forget(t.path);
          if (t.kind === 'simulator') useCircuit.getState().revert();
          closeTab(t.id);
        },
      });
      return;
    }
    if (t.path) useEditor.getState().forget(t.path);
    closeTab(t.id);
  };

  return (
    <>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === active.id}
            className={`tab${t.id === active.id ? ' active' : ''}`}
            onClick={() => setActiveTab(t.id)}
            onAuxClick={(e) => e.button === 1 && close(t)}
            title={t.path ?? t.title}
          >
            <TabIcon tab={t} />
            <span className="ellipsis">{t.title}</span>
            <span
              className={`close${isDirty(t) ? ' dirty' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                close(t);
              }}
            >
              {!isDirty(t) && <X size={12} />}
            </span>
          </div>
        ))}
      </div>
      <div className="tab-body">
        <ErrorBoundary key={active.id} area={active.title}>
          {active.kind === 'home' && <HomePage />}
          {active.kind === 'file' && active.path && <CodeEditor path={active.path} />}
          {active.kind === 'simulator' && <SimulatorPage />}
          {active.kind === 'settings' && <SettingsPage />}
          {active.kind === 'setup' && <SetupPage />}
          {active.kind === 'proposal' && active.proposalId && <ProposalReview id={active.proposalId} />}
        </ErrorBoundary>
      </div>
    </>
  );
}
