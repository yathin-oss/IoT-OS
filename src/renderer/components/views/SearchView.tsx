import { useState } from 'react';
import type { SearchMatch } from '../../../core/ipc/contract';
import { call, errorMessage } from '../../api/client';
import { useProject } from '../../state/project';
import { useUi } from '../../state/ui';

export function SearchView() {
  const hasProject = useProject((s) => s.snapshot !== null);
  const [q, setQ] = useState('');
  const [regex, setRegex] = useState(false);
  const [cs, setCs] = useState(false);
  const [results, setResults] = useState<SearchMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!q) return;
    try {
      setError(null);
      setResults(await call('fs.search', { query: q, regex, caseSensitive: cs }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  if (!hasProject) return <div className="empty">Open a project to search its files.</div>;
  const byFile = new Map<string, SearchMatch[]>();
  for (const r of results ?? []) byFile.set(r.path, [...(byFile.get(r.path) ?? []), r]);
  return (
    <>
      <div className="sidebar-head">Search</div>
      <div className="col" style={{ padding: '0 10px 8px' }}>
        <input className="input" placeholder="Search in project (Enter)" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void run()} />
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Regex
          </label>
          <label className="check">
            <input type="checkbox" checked={cs} onChange={(e) => setCs(e.target.checked)} /> Match case
          </label>
        </div>
        <span className="faint">Use the editor (⌘/Ctrl+F, ⌘/Ctrl+H) for find &amp; replace inside a file.</span>
      </div>
      <div className="sidebar-body">
        {error && <div className="empty sev-error">{error}</div>}
        {results && results.length === 0 && <div className="empty">No results</div>}
        {[...byFile].map(([path, ms]) => (
          <div key={path}>
            <div className="section-title" style={{ textTransform: 'none', letterSpacing: 0 }}>
              {path} <span className="badge">{ms.length}</span>
            </div>
            {ms.map((m) => (
              <div key={`${m.line}:${m.column}`} className="list-row click mono" style={{ fontSize: 11.5, paddingLeft: 18 }} onClick={() => useUi.getState().revealLocation(m.path, m.line, m.column)}>
                <span className="faint">{m.line}</span>
                <span className="ellipsis">{m.text.trim()}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
