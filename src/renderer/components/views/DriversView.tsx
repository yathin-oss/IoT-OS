import { ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DriverScan } from '../../../core/ipc/contract';
import { call, errorMessage } from '../../api/client';
import { useApp } from '../../state/runtime';
import { useUi } from '../../state/ui';

const STATE: Record<string, string> = { ok: 'ok', missing: 'err', 'not-required': 'info', unknown: 'warn' };

export function openVendorPage(url: string) {
  const ui = useUi.getState();
  const runtime = useApp.getState().info?.runtime;
  ui.setDialog({
    kind: 'confirm',
    title: 'Open driver download page',
    message: `IoT-OS never downloads or installs drivers itself. This opens the vendor's official page in your browser:\n\n${url}\n\nInstall only signed drivers from the chip vendor, and approve them in your OS security settings when asked.`,
    confirmLabel: 'Open vendor page',
    onConfirm: () => {
      // The browser host runs inside a browser already: open a normal tab (no opener).
      if (runtime === 'browser-host') window.open(url, '_blank', 'noopener,noreferrer');
      else void call('app.openExternal', { url }).catch((e: unknown) => ui.toast('error', errorMessage(e)));
    },
  });
}

export function DriversView() {
  const [scan, setScan] = useState<DriverScan | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      setScan(await call('drivers.scan'));
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run();
  }, []);
  return (
    <>
      <div className="sidebar-head">
        <span className="grow">USB drivers</span>
        <button className="icon-btn" title="Scan USB devices" onClick={() => void run()} disabled={busy}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="sidebar-body">
        <div className="faint" style={{ padding: '0 12px 6px', fontSize: 11.5 }}>
          <ShieldCheck size={12} style={{ verticalAlign: -2 }} /> Diagnostics only: IoT-OS identifies USB-serial chips and links to the vendor's signed driver. It never installs drivers silently.
        </div>
        {busy && <div className="empty">Scanning USB devices…</div>}
        {scan && (
          <>
            <div style={{ padding: '0 12px 6px' }}>
              {scan.message} <span className="faint">({scan.method})</span>
            </div>
            {scan.devices.map((d, i) => (
              <div key={`${d.vid}:${d.pid}:${i}`} className="card" style={{ margin: '6px 10px', padding: 8 }}>
                <div className="row">
                  <b className="grow ellipsis">{d.chip ?? d.name}</b>
                  <span className={`badge ${STATE[d.driverState]}`}>{d.driverState}</span>
                </div>
                <div className="faint" style={{ fontSize: 11.5 }}>
                  {d.name} · USB {d.vid}:{d.pid}
                  {d.manufacturer ? ` · ${d.manufacturer}` : ''}
                </div>
                <div style={{ fontSize: 11.5 }}>Ports: {d.serialPorts.length ? <span className="mono">{d.serialPorts.join(', ')}</span> : <span className="sev-warning">none</span>}</div>
                <div style={{ fontSize: 12, marginTop: 4 }}>
                  <b>{d.driver.name}</b> <span className="muted">({d.driver.vendor}{d.driver.builtIn ? ', normally built into this OS' : ''})</span>
                </div>
                <div className="muted selectable" style={{ fontSize: 12 }}>
                  {d.driver.guidance}
                </div>
                {d.driver.downloadUrl && d.driverState !== 'ok' && (
                  <button className="btn sm" style={{ marginTop: 6 }} onClick={() => openVendorPage(d.driver.downloadUrl!)}>
                    <ExternalLink size={12} /> Vendor driver page
                  </button>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}
