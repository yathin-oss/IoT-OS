import { Activity, Hammer, Plug, PlugZap, RefreshCw, Stethoscope, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CoreStatus, Device, DeviceDiagnosis, ToolStatus } from '../../../core/ipc/contract';
import { getRegistry } from '../../../core/registry/registry';
import { call, errorMessage } from '../../api/client';
import { runCommand } from '../../commands';
import { useProject } from '../../state/project';
import { useDevices, useSerial } from '../../state/runtime';
import { useUi } from '../../state/ui';

const STATE_BADGE: Record<Device['state'], string> = { CONNECTED: 'ok', DISCONNECTED: '', DRIVER_MISSING: 'err', PORT_BUSY: 'warn', UNKNOWN: 'info' };

function DeviceRow({ d, selected }: { d: Device; selected: boolean }) {
  const select = useDevices((s) => s.select);
  const serial = useSerial();
  const [diag, setDiag] = useState<DeviceDiagnosis | null>(null);
  const reg = getRegistry();
  const isOpen = serial.status.open && serial.status.port === d.port;
  return (
    <div className={`card`} style={{ margin: '6px 10px', padding: 8, borderColor: selected ? 'var(--accent)' : undefined }} onClick={() => d.port && select(d.port)}>
      <div className="row">
        <PlugZap size={14} className={d.state === 'CONNECTED' ? 'sev-info' : 'muted'} />
        <span className="grow ellipsis mono" style={{ fontSize: 12 }} title={d.port}>
          {d.port ? d.port.replace('/dev/', '') : d.product ?? 'USB device'}
        </span>
        <span className={`badge ${STATE_BADGE[d.state]}`}>{d.state}</span>
      </div>
      <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>
        {d.vid ? `USB ${d.vid}:${d.pid}` : 'No USB IDs'}
        {d.usbChip.chip ? ` · ${d.usbChip.chip}` : d.usbChip.family !== 'unknown' ? ` · ${d.usbChip.family}` : ''}
        {d.manufacturer ? ` · ${d.manufacturer}` : ''}
      </div>
      {d.candidates.length > 0 && (
        <div style={{ fontSize: 11.5, marginTop: 2 }}>
          {d.candidates.slice(0, 3).map((c) => (
            <span key={c.boardId} className="badge" style={{ marginRight: 4 }} title={c.note}>
              {reg.getBoard(c.boardId)?.name.split(' (')[0]} · {c.confidence}
            </span>
          ))}
        </div>
      )}
      {d.state !== 'DISCONNECTED' && d.port && (
        <div className="row" style={{ marginTop: 6, flexWrap: 'wrap', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          {isOpen ? (
            <button className="btn sm" onClick={() => void serial.close()}>
              <Plug size={12} /> Disconnect
            </button>
          ) : (
            <button
              className="btn sm"
              onClick={() => {
                select(d.port);
                useUi.getState().showBottom('serial');
                void serial.open();
              }}
            >
              <Activity size={12} /> Connect / Serial
            </button>
          )}
          <button className="btn sm" onClick={() => runCommand('build.run')}>
            <Hammer size={12} /> Build
          </button>
          <button
            className="btn sm"
            onClick={() => {
              select(d.port);
              runCommand('build.upload');
            }}
          >
            <Upload size={12} /> Upload
          </button>
          <button
            className="btn sm"
            onClick={() =>
              void call('devices.diagnose', { port: d.port })
                .then(setDiag)
                .catch((e: unknown) => useUi.getState().toast('error', errorMessage(e)))
            }
          >
            <Stethoscope size={12} /> Diagnose
          </button>
        </div>
      )}
      {diag && (
        <div className="selectable" style={{ marginTop: 6, fontSize: 12 }}>
          {diag.findings.map((f, i) => (
            <div key={i} className={f.level === 'error' ? 'sev-error' : f.level === 'warning' ? 'sev-warning' : f.level === 'ok' ? '' : 'muted'}>
              {f.level === 'ok' ? '✓' : f.level === 'error' ? '✗' : '•'} {f.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ToolchainSection() {
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [cores, setCores] = useState<CoreStatus[] | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const load = async (refresh = false) => {
    try {
      const [t, c] = await Promise.all([call('toolchain.status', { refresh }), call('toolchain.cores')]);
      setTools(t);
      setCores(c);
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const cliOk = tools?.find((t) => t.id === 'arduino-cli')?.state === 'installed';
  return (
    <>
      <div className="section-title">
        Toolchains
        <span className="spacer" />
        <button className="icon-btn" title="Re-detect" onClick={() => void load(true)}>
          <RefreshCw size={12} />
        </button>
      </div>
      {!tools && <div className="empty">Detecting…</div>}
      {tools?.map((t) => (
        <div key={t.id} className="list-row" title={t.path ?? t.message} style={{ alignItems: 'flex-start' }}>
          <span className={`badge ${t.state === 'installed' ? 'ok' : t.state === 'missing' ? 'err' : t.state === 'unsupported' ? '' : 'warn'}`} style={{ width: 62, justifyContent: 'center' }}>
            {t.state === 'installed' ? t.version ?? 'found' : t.state}
          </span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div>{t.name}</div>
            {t.state !== 'installed' && t.fix && <div className="faint selectable mono" style={{ fontSize: 11 }}>{t.fix}</div>}
          </div>
        </div>
      ))}
      {cores && (
        <>
          <div className="section-title">Board packages</div>
          {cores.map((c) => (
            <div key={c.core} className="list-row">
              <span className={`badge ${c.installed ? 'ok' : 'warn'}`} style={{ width: 62, justifyContent: 'center' }}>
                {c.installed ?? 'missing'}
              </span>
              <span className="grow ellipsis mono" style={{ fontSize: 11.5 }}>
                {c.core}
              </span>
              {!c.installed && (
                <button
                  className="btn sm"
                  disabled={!cliOk || installing !== null}
                  title={cliOk ? `Install ${c.core}` : 'Install Arduino CLI first'}
                  onClick={() => {
                    setInstalling(c.core);
                    useUi.getState().showBottom('terminal');
                    void call('toolchain.installCore', { boardId: c.boards[0]! })
                      .then((r) => useUi.getState().toast(r.ok ? 'success' : 'error', r.message))
                      .catch((e: unknown) => useUi.getState().toast('error', errorMessage(e)))
                      .finally(() => {
                        setInstalling(null);
                        void load();
                      });
                  }}
                >
                  {installing === c.core ? 'Installing…' : 'Install'}
                </button>
              )}
            </div>
          ))}
        </>
      )}
    </>
  );
}

export function DevicesView() {
  const { devices, selectedPort, refresh } = useDevices();
  const snapshot = useProject((s) => s.snapshot);
  const board = snapshot ? getRegistry().getBoard(snapshot.hardware.boardId) : undefined;
  return (
    <>
      <div className="sidebar-head">
        <span className="grow">Devices</span>
        <button className="icon-btn" title="Refresh" onClick={() => void refresh()}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="sidebar-body">
        {board && (
          <div className="kv" style={{ paddingBottom: 6 }}>
            <span className="k">Project board</span>
            <span>{board.name}</span>
            <span className="k">Upload port</span>
            <span className="mono ellipsis">{selectedPort ?? '—'}</span>
          </div>
        )}
        {devices.length === 0 && (
          <div className="empty">
            <h4>No boards detected</h4>
            Plug in a board with a data-capable USB cable. Boards appear here automatically. If a board is connected but missing, check the Drivers view.
          </div>
        )}
        {devices.map((d) => (
          <DeviceRow key={d.id} d={d} selected={d.port === selectedPort} />
        ))}
        <ToolchainSection />
      </div>
    </>
  );
}
