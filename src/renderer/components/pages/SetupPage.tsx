import { CheckCircle2, CircleAlert, CircleX, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SetupCheck, SetupReport } from '../../../core/ipc/contract';
import { call, errorMessage } from '../../api/client';
import { useUi } from '../../state/ui';
import { openVendorPage } from '../views/DriversView';

function Icon({ s }: { s: SetupCheck['status'] }) {
  if (s === 'ok') return <CheckCircle2 size={15} style={{ color: 'var(--ok)', flex: 'none' }} />;
  if (s === 'warning') return <CircleAlert size={15} className="sev-warning" style={{ flex: 'none' }} />;
  return <CircleX size={15} className="sev-error" style={{ flex: 'none' }} />;
}

export function SetupPage() {
  const [report, setReport] = useState<SetupReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const ui = useUi();
  const run = async () => {
    setBusy(true);
    try {
      setReport(await call('setup.check'));
    } catch (err) {
      ui.toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run();
  }, []);
  const act = (c: SetupCheck) => {
    const a = c.action;
    if (!a) return;
    if (a.kind === 'open-settings') ui.openTab({ id: 'settings', kind: 'settings', title: 'Settings' });
    else if (a.kind === 'open-url') openVendorPage(a.url);
    else if (a.kind === 'install-core') {
      setInstalling(c.id);
      ui.showBottom('terminal');
      void call('toolchain.installCore', { boardId: a.boardId })
        .then((r) => ui.toast(r.ok ? 'success' : 'error', r.message))
        .catch((e: unknown) => ui.toast('error', errorMessage(e)))
        .finally(() => {
          setInstalling(null);
          void run();
        });
    }
  };
  const missing = report?.checks.filter((c) => c.status !== 'ok').length ?? 0;
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 860 }}>
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Environment setup</h2>
          <span className="spacer" />
          <button className="btn" onClick={() => void run()} disabled={busy}>
            <RefreshCw size={13} /> {busy ? 'Checking…' : 'Re-check'}
          </button>
        </div>
        <div className="muted" style={{ marginBottom: 12 }}>
          {report ? (missing ? `${missing} item(s) need attention. Each shows what is missing and how to fix it.` : 'Everything IoT-OS needs is available.') : 'Checking toolchains, board packages, serial access and drivers…'}
        </div>
        <div className="card">
          {report?.checks.map((c) => (
            <div key={c.id} className="list-row" style={{ alignItems: 'flex-start', padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
              <Icon s={c.status} />
              <div className="grow selectable" style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{c.title}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {c.detail}
                </div>
                {c.fix && c.status !== 'ok' && (
                  <div className="mono faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                    {c.fix}
                  </div>
                )}
              </div>
              {c.action && c.status !== 'ok' && (
                <button className="btn sm" onClick={() => act(c)} disabled={installing !== null}>
                  {c.action.kind === 'install-core' ? (installing === c.id ? 'Installing…' : 'Install') : c.action.kind === 'open-url' ? 'Open docs' : 'Open settings'}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
