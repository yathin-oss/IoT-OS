import { useEffect, useRef, useState } from 'react';
import type { LogLevel } from '../../../core/ipc/contract';
import { useProcesses } from '../../state/runtime';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function OutputPanel() {
  const logs = useProcesses((s) => s.logs);
  const [level, setLevel] = useState<LogLevel>('info');
  const box = useRef<HTMLDivElement>(null);
  const shown = logs.filter((l) => ORDER[l.level] >= ORDER[level]);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length]);
  return (
    <>
      <div className="toolbar">
        <span className="muted">Application log (secrets are redacted)</span>
        <span className="spacer" />
        <select className="select" value={level} onChange={(e) => setLevel(e.target.value as LogLevel)} style={{ height: 22 }}>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warnings</option>
          <option value="error">Errors</option>
        </select>
      </div>
      <div className="console" ref={box}>
        {shown.map((l, i) => (
          <div key={i} className={l.level === 'error' ? 'sev-error' : l.level === 'warn' ? 'sev-warning' : ''}>
            <span className="ts">{l.t.slice(11, 23)}</span>
            <span className="faint">[{l.scope}]</span> {l.message}
            {l.fields ? <span className="faint"> {JSON.stringify(l.fields)}</span> : null}
          </div>
        ))}
      </div>
    </>
  );
}
