import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert, CircleDashed, CircleX, Loader2, MinusCircle } from 'lucide-react';
import { useState } from 'react';
import type { BuildStep } from '../../../core/ipc/contract';
import { runCommand } from '../../commands';
import { useBuild } from '../../state/runtime';
import { useProcesses } from '../../state/runtime';

function StepIcon({ s }: { s: BuildStep['status'] }) {
  const p = { size: 14, style: { flex: 'none' as const } };
  switch (s) {
    case 'ok':
      return <CheckCircle2 {...p} color="var(--ok)" />;
    case 'warning':
      return <CircleAlert {...p} color="var(--warn)" />;
    case 'failed':
      return <CircleX {...p} color="var(--err)" />;
    case 'running':
      return <Loader2 {...p} className="spin" color="var(--accent)" />;
    case 'skipped':
      return <MinusCircle {...p} color="var(--text-faint)" />;
    default:
      return <CircleDashed {...p} color="var(--text-faint)" />;
  }
}

export function BuildPanel() {
  const { running, steps, last, flashing, flashProgress, lastFlash, pendingConfirm, upload } = useBuild();
  const output = useProcesses((s) => s.output);
  const [showLog, setShowLog] = useState(false);
  const procId = last?.processId;
  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ width: 380, borderRight: '1px solid var(--border)', overflow: 'auto', flex: 'none' }}>
        <div className="toolbar">
          <b>Build</b>
          {last && !running && (
            <span className={`badge ${last.status === 'succeeded' ? 'ok' : last.status === 'cancelled' ? '' : 'err'}`}>
              {last.status} · {(last.durationMs / 1000).toFixed(1)} s
            </span>
          )}
          <span className="spacer" />
          <button className="btn sm" disabled={running} onClick={() => runCommand('build.run')}>
            Build
          </button>
        </div>
        {steps.length === 0 && !running && <div className="empty">No build yet. Press Build (⌘/Ctrl+Shift+B).</div>}
        {steps.map((s) => (
          <div key={s.id} className="list-row" style={{ alignItems: 'flex-start' }} data-testid={`build-step-${s.id}`}>
            <StepIcon s={s.status} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div>
                {s.title} {s.durationMs !== null && <span className="faint">{s.durationMs} ms</span>}
              </div>
              {s.detail && <div className="muted selectable" style={{ fontSize: 12 }}>{s.detail}</div>}
            </div>
          </div>
        ))}
        {last && !running && (
          <div style={{ padding: '6px 12px' }}>
            {last.message && <div className={last.status === 'succeeded' ? '' : 'sev-error'}>{last.message}</div>}
            {last.artifacts.map((a) => (
              <div key={a.path} className="mono faint" style={{ fontSize: 11.5 }}>
                {a.path} · {a.bytes} B
              </div>
            ))}
          </div>
        )}
        <div className="divider" />
        <div className="toolbar">
          <b>Upload</b>
          {lastFlash && !flashing && <span className={`badge ${lastFlash.status === 'succeeded' ? 'ok' : lastFlash.status === 'needs-confirmation' ? 'warn' : 'err'}`}>{lastFlash.status}</span>}
        </div>
        {flashing && (
          <div style={{ padding: '6px 12px' }}>
            <div style={{ height: 4, background: 'var(--bg-4)', borderRadius: 2 }}>
              <div style={{ height: 4, width: `${flashProgress?.percent ?? 5}%`, background: 'var(--accent)', borderRadius: 2, transition: 'width .2s' }} />
            </div>
            <div className="muted mono ellipsis" style={{ fontSize: 11.5, marginTop: 4 }}>
              {flashProgress?.message}
            </div>
          </div>
        )}
        {lastFlash && !flashing && (
          <div style={{ padding: '4px 12px 10px' }}>
            {lastFlash.checks.map((c) => (
              <div key={c.id} className={`selectable ${c.status === 'blocked' ? 'sev-error' : c.status === 'warning' ? 'sev-warning' : 'muted'}`} style={{ fontSize: 12 }}>
                {c.status === 'ok' ? '✓' : c.status === 'blocked' ? '✗' : '!'} {c.message}
              </div>
            ))}
            {lastFlash.failure && (
              <div className="selectable" style={{ marginTop: 6 }}>
                <div className="sev-error">{lastFlash.failure.message}</div>
                <div className="muted">{lastFlash.failure.hint}</div>
              </div>
            )}
            {pendingConfirm && (
              <div className="card" style={{ padding: 8, marginTop: 8 }}>
                <div style={{ marginBottom: 6 }}>Confirm to continue uploading:</div>
                {pendingConfirm.checks
                  .filter((c) => c.confirmable && c.status === 'warning')
                  .map((c) => (
                    <div key={c.id} className="sev-warning" style={{ fontSize: 12 }}>
                      • {c.message}
                    </div>
                  ))}
                <button className="btn sm primary" style={{ marginTop: 8 }} onClick={() => void upload(pendingConfirm.checks.filter((c) => c.confirmable).map((c) => c.id))} data-testid="confirm-upload">
                  Upload anyway
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="toolbar">
          <button className="btn sm ghost" onClick={() => setShowLog(!showLog)}>
            {showLog ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Full compiler log
          </button>
          <span className="faint">{last?.fqbn ?? ''}</span>
        </div>
        <div className="console">
          {showLog && procId ? output[procId] ?? '(open the Terminal panel for live output)' : (last?.outputTail ?? []).join('\n') || <span className="faint">Compiler output appears here.</span>}
        </div>
      </div>
    </div>
  );
}
