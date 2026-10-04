import { Bot, Wrench } from 'lucide-react';
import { useState } from 'react';
import type { Diagnostic } from '../../../core/diagnostics';
import { call } from '../../api/client';
import { contextOptions, runCommand } from '../../commands';
import { useProject } from '../../state/project';
import { useAi } from '../../state/runtime';
import { useUi } from '../../state/ui';
import { useAllProblems } from './problems';
import { SeverityIcon } from './SeverityIcon';

function locate(d: Diagnostic) {
  const ui = useUi.getState();
  if (d.target?.file && d.target.line) ui.revealLocation(d.target.file, d.target.line, d.target.column ?? 1);
  else if (d.target?.file) ui.openTab({ id: `file:${d.target.file}`, kind: 'file', title: d.target.file.split('/').pop()!, path: d.target.file });
  else if (d.target?.componentId) ui.revealComponent(d.target.componentId);
  else if (d.source === 'hardware') ui.openTab({ id: 'simulator', kind: 'simulator', title: 'Simulator' });
}

function describe(d: Diagnostic): string {
  const loc = d.target?.file ? ` at ${d.target.file}${d.target.line ? `:${d.target.line}` : ''}` : d.target?.componentId ? ` on component ${d.target.componentId}` : '';
  return `${d.severity.toUpperCase()} ${d.code}${loc}: ${d.message}${d.hint ? ` (hint: ${d.hint})` : ''}`;
}

export function ProblemsPanel() {
  const problems = useAllProblems();
  const hasProject = useProject((s) => s.snapshot !== null);
  const [showInfo, setShowInfo] = useState(true);
  const list = showInfo ? problems : problems.filter((p) => p.severity !== 'info');
  if (!hasProject) return <div className="empty">No project open.</div>;
  return (
    <>
      <div className="toolbar">
        <span className="muted">{problems.length} problem(s)</span>
        <label className="check">
          <input type="checkbox" checked={showInfo} onChange={(e) => setShowInfo(e.target.checked)} /> Show info
        </label>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => runCommand('pins.sync')} title="Regenerate the firmware pin configuration from the circuit">
          Sync pins
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }} data-testid="problems-list">
        {list.length === 0 && <div className="empty">No problems detected.</div>}
        {list.map((d, i) => (
          <div key={i} className="list-row click" style={{ alignItems: 'flex-start' }} onClick={() => locate(d)}>
            <SeverityIcon severity={d.severity} />
            <div className="grow selectable" style={{ minWidth: 0 }}>
              <span>{d.message}</span>
              <span className="faint">
                {' '}
                · {d.source} {d.code}
                {d.target?.file ? ` · ${d.target.file}${d.target.line ? `:${d.target.line}` : ''}` : ''}
              </span>
              {d.hint && <div className="muted" style={{ fontSize: 12 }}>{d.hint}</div>}
            </div>
            {(d.severity === 'error' || d.severity === 'warning' || d.severity === 'blocking') && (
              <div className="row" style={{ gap: 2 }} onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn sm ghost"
                  title="Explain with AI"
                  onClick={() => void useAi.getState().run('Explaining problem', () => call('ai.explain', { subject: `this problem reported by IoT-OS: ${describe(d)}`, options: { ...contextOptions(), ...(d.target?.file ? { activeFile: d.target.file } : {}) } }))}
                >
                  <Bot size={12} /> Explain
                </button>
                <button
                  className="btn sm ghost"
                  title="Fix with AI (creates a reviewable proposal)"
                  onClick={() => {
                    const ai = useAi.getState();
                    if (d.source === 'compiler' || d.source === 'linker' || d.source === 'toolchain') void ai.run('Fixing build', () => call('ai.fixBuild', { question: `Fix: ${describe(d)}`, options: contextOptions() }));
                    else if (d.source === 'hardware') void ai.run('Fixing circuit', () => call('ai.planCircuit', { request: `Fix this validation problem with minimal changes: ${describe(d)}` }));
                    else void ai.run('Fixing', () => call('ai.editCode', { instruction: `Fix this problem: ${describe(d)}`, options: contextOptions() }));
                  }}
                >
                  <Wrench size={12} /> Fix
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
