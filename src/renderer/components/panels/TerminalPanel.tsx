import { useEffect, useRef, useState } from 'react';
import { call } from '../../api/client';
import { useProcesses } from '../../state/runtime';

const STATUS: Record<string, string> = { running: 'info', succeeded: 'ok', failed: 'err', cancelled: '', 'timed-out': 'warn' };

/**
 * Tool process terminal: every external program IoT-OS runs (compilers,
 * uploaders, package managers) with its exact command, live output, exit code
 * and duration. There is intentionally no free-form shell.
 */
export function TerminalPanel() {
  const { processes, output } = useProcesses();
  const [sel, setSel] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<string, string>>({});
  const current = sel ?? processes[0]?.id ?? null;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (current && output[current] === undefined && loaded[current] === undefined) {
      void call('process.output', { id: current }).then((t) => setLoaded((l) => ({ ...l, [current]: t })));
    }
  }, [current, output, loaded]);
  const text = current ? (output[current] ?? loaded[current] ?? '') : '';
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);
  const p = processes.find((x) => x.id === current);
  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ width: 300, borderRight: '1px solid var(--border)', overflow: 'auto', flex: 'none' }}>
        {processes.length === 0 && <div className="empty">No tool processes have run yet.</div>}
        {processes.map((r) => (
          <div key={r.id} className={`list-row click${r.id === current ? ' active' : ''}`} onClick={() => setSel(r.id)} title={r.command}>
            <span className={`badge ${STATUS[r.status]}`}>{r.status === 'running' ? '…' : r.exitCode ?? '–'}</span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis">{r.purpose}</div>
              <div className="faint" style={{ fontSize: 11 }}>
                {r.tool} · {new Date(r.startedAt).toLocaleTimeString()}
                {r.durationMs !== null ? ` · ${(r.durationMs / 1000).toFixed(1)} s` : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {p && (
          <div className="toolbar mono selectable" style={{ fontSize: 11.5 }}>
            <span className="faint">$</span> <span className="ellipsis">{p.command}</span>
          </div>
        )}
        <div className="console" ref={box}>
          {text || <span className="faint">{p ? 'No output.' : ''}</span>}
        </div>
      </div>
    </div>
  );
}
