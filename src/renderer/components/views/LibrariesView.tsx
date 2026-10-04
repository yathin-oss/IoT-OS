import { ArrowUpCircle, Download, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DependencyResolution, InstalledLibrary, LibraryEcosystem, LibraryInfo } from '../../../core/ipc/contract';
import { call, errorMessage } from '../../api/client';
import { useProject } from '../../state/project';
import { useUi } from '../../state/ui';

const COMPAT: Record<string, string> = { compatible: 'ok', incompatible: 'err', unknown: '' };

export function LibrariesView() {
  const snapshot = useProject((s) => s.snapshot);
  const ecosystem: LibraryEcosystem = snapshot?.manifest.language === 'micropython' ? 'micropython-mip' : 'arduino';
  const [q, setQ] = useState('');
  const [results, setResults] = useState<LibraryInfo[] | null>(null);
  const [installed, setInstalled] = useState<InstalledLibrary[] | null>(null);
  const [resolution, setResolution] = useState<DependencyResolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, string>>({});

  const loadInstalled = useCallback(async () => {
    setError(null);
    try {
      const [inst, res] = await Promise.all([call('libraries.installed', { ecosystem }), snapshot ? call('libraries.resolve') : Promise.resolve(null)]);
      setInstalled(inst);
      setResolution(res);
    } catch (err) {
      setError(errorMessage(err));
      setInstalled(null);
      if (snapshot) call('libraries.resolve').then(setResolution).catch(() => undefined);
    }
  }, [ecosystem, snapshot]);

  useEffect(() => {
    void loadInstalled();
  }, [loadInstalled]);

  const search = async () => {
    setError(null);
    setBusy('search');
    try {
      setResults(await call('libraries.search', { ecosystem, query: q }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const op = async (label: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(label);
    useUi.getState().showBottom('terminal');
    try {
      const r = await fn();
      useUi.getState().toast(r.ok ? 'success' : 'error', r.message);
      await loadInstalled();
      void useProject.getState().refreshDiagnostics();
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="sidebar-head">
        <span className="grow">Libraries · {ecosystem === 'arduino' ? 'Arduino' : 'MicroPython mip'}</span>
        <button className="icon-btn" title="Refresh" onClick={() => void loadInstalled()}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="col" style={{ padding: '0 10px 8px' }}>
        <input className="input" placeholder={`Search ${ecosystem === 'arduino' ? 'Arduino Library Manager' : 'micropython-lib'} (Enter)`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void search()} />
      </div>
      <div className="sidebar-body">
        {error && <div className="empty sev-error selectable">{error}</div>}
        {resolution && resolution.status.length > 0 && (
          <>
            <div className="section-title">Project dependencies</div>
            {resolution.status.map((s) => (
              <div key={s.name} className="list-row">
                <span className={`badge ${s.state === 'ok' ? 'ok' : s.state === 'missing' ? 'err' : s.state === 'unknown' ? '' : 'warn'}`}>{s.state}</span>
                <span className="grow ellipsis">{s.name}</span>
                <span className="faint mono" style={{ fontSize: 11 }}>
                  {s.installedVersion ?? s.declaredVersion ?? ''}
                </span>
                {(s.state === 'missing' || s.state === 'not-declared') && (
                  <button className="btn sm" disabled={busy !== null} onClick={() => void op(s.name, () => call('libraries.install', { ecosystem, name: s.name, ...(s.declaredVersion ? { version: s.declaredVersion } : {}), addToProject: true }))}>
                    {s.state === 'missing' ? 'Install' : 'Declare'}
                  </button>
                )}
              </div>
            ))}
            {!resolution.checked && <div className="faint" style={{ padding: '2px 12px' }}>{resolution.message}</div>}
          </>
        )}
        {results && (
          <>
            <div className="section-title">Search results</div>
            {results.length === 0 && <div className="empty">No libraries found.</div>}
            {results.map((l) => (
              <div key={l.name} className="card" style={{ margin: '4px 10px', padding: 8 }}>
                <div className="row">
                  <b className="grow ellipsis">{l.name}</b>
                  <span className={`badge ${COMPAT[l.compatibility]}`} title={l.architectures.join(', ')}>
                    {l.compatibility}
                  </span>
                </div>
                {l.sentence && <div className="muted" style={{ fontSize: 12 }}>{l.sentence}</div>}
                <div className="row" style={{ marginTop: 6 }}>
                  <span className="faint grow ellipsis" style={{ fontSize: 11.5 }}>
                    {l.author}
                  </span>
                  {l.versions.length > 0 && (
                    <select className="select" style={{ height: 22, fontSize: 11.5 }} value={versions[l.name] ?? l.latest ?? ''} onChange={(e) => setVersions({ ...versions, [l.name]: e.target.value })}>
                      {l.versions.slice(0, 30).map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  )}
                  <button className="btn sm primary" disabled={busy !== null} onClick={() => void op(l.name, () => call('libraries.install', { ecosystem, name: l.name, ...((versions[l.name] ?? l.latest) ? { version: versions[l.name] ?? l.latest! } : {}), addToProject: !!snapshot }))}>
                    <Download size={12} /> {busy === l.name ? '…' : 'Install'}
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
        <div className="section-title">Installed</div>
        {installed === null && !error && <div className="empty">Loading…</div>}
        {installed?.length === 0 && <div className="empty">No libraries installed.</div>}
        {installed?.map((l) => (
          <div key={l.name} className="list-row" title={l.location ?? ''}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis">{l.name}</div>
              <div className="faint" style={{ fontSize: 11 }}>
                {l.version}
                {l.dependencies.length ? ` · deps: ${l.dependencies.join(', ')}` : ''}
              </div>
            </div>
            {l.compatibility === 'incompatible' && <span className="badge err">incompatible</span>}
            {l.updateAvailable && (
              <button className="icon-btn" title={`Update to ${l.latest}`} onClick={() => void op(l.name, () => call('libraries.upgrade', { ecosystem, name: l.name }))}>
                <ArrowUpCircle size={13} className="sev-info" />
              </button>
            )}
            <button className="icon-btn" title="Uninstall" disabled={busy !== null} onClick={() => void op(l.name, () => call('libraries.uninstall', { ecosystem, name: l.name, removeFromProject: !!snapshot }))}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
