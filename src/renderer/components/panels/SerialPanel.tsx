import { Bot, Download, Pause, Play, Plug, PlugZap, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseAnsi } from '../../../core/serial/ansi';
import type { LineEnding, SerialLine } from '../../../core/serial/lines';
import { call } from '../../api/client';
import { contextOptions } from '../../commands';
import { serialBuffer, useAi, useDevices, useSerial } from '../../state/runtime';

const ROW = 18;
const BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 460800, 921600];

function fmtTime(t: number): string {
  const d = new Date(t);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function Line({ line, ts }: { line: SerialLine; ts: boolean }) {
  const spans = useMemo(() => parseAnsi(line.text), [line.text]);
  return (
    <div style={{ height: ROW, whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis' }} className={line.seq < 0 ? 'sev-warning' : ''}>
      {ts && <span className="ts">{fmtTime(line.t)}</span>}
      {spans.map((s, i) => (
        <span key={i} className={[s.fg ? `ansi-${s.fg}` : '', s.bold ? 'ansi-bold' : ''].join(' ')}>
          {s.text}
        </span>
      ))}
    </div>
  );
}

export function SerialPanel() {
  const s = useSerial();
  const { devices, selectedPort, select } = useDevices();
  const [input, setInput] = useState('');
  const [hist, setHist] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(300);
  const box = useRef<HTMLDivElement>(null);
  const filterError = useRef<string | null>(null);

  const lines = useMemo(() => {
    void s.version;
    if (!s.filter) return serialBuffer.lines;
    try {
      filterError.current = null;
      const re = s.filterRegex ? new RegExp(s.filter, 'i') : null;
      const f = s.filter.toLowerCase();
      return serialBuffer.lines.filter((l) => (re ? re.test(l.text) : l.text.toLowerCase().includes(f)));
    } catch (err) {
      filterError.current = (err as Error).message;
      return serialBuffer.lines;
    }
  }, [s.version, s.filter, s.filterRegex]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (s.autoscroll && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines.length, s.autoscroll]);

  const first = Math.max(0, Math.floor(scrollTop / ROW) - 10);
  const last = Math.min(lines.length, Math.ceil((scrollTop + height) / ROW) + 10);
  const exportLog = () => {
    const text = serialBuffer.lines.map((l) => `${new Date(l.t).toISOString()}\t${l.text}`).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `serial-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const send = () => {
    if (!s.status.open) return;
    void s.send(input);
    setHist((h) => [input, ...h.filter((x) => x !== input)].slice(0, 50));
    setHistIdx(-1);
    setInput('');
  };
  const portOptions = devices.filter((d) => d.port && d.state !== 'DISCONNECTED');

  return (
    <>
      <div className="toolbar" style={{ gap: 4 }}>
        <select className="select" style={{ height: 22, maxWidth: 220 }} value={selectedPort ?? ''} onChange={(e) => select(e.target.value || null)} disabled={s.status.open} data-testid="serial-port">
          <option value="">{portOptions.length ? 'Select port' : 'No ports'}</option>
          {portOptions.map((d) => (
            <option key={d.port} value={d.port}>
              {d.port.replace('/dev/', '')}
              {d.usbChip.chip ? ` (${d.usbChip.chip})` : ''}
            </option>
          ))}
        </select>
        <select className="select" style={{ height: 22 }} value={s.baud} onChange={(e) => s.set({ baud: Number(e.target.value) })} disabled={s.status.open} title="Baud rate">
          {BAUDS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        {s.status.open ? (
          <button className="btn sm" onClick={() => void s.close()}>
            <Plug size={12} /> Disconnect
          </button>
        ) : (
          <button className="btn sm primary" onClick={() => void s.open()} disabled={!selectedPort}>
            <PlugZap size={12} /> Connect
          </button>
        )}
        <div style={{ width: 8 }} />
        <input className="input" style={{ height: 22, width: 160 }} placeholder="Filter" value={s.filter} onChange={(e) => s.set({ filter: e.target.value })} title={filterError.current ?? 'Filter lines'} />
        <label className="check" title="Treat filter as a regular expression">
          <input type="checkbox" checked={s.filterRegex} onChange={(e) => s.set({ filterRegex: e.target.checked })} /> .*
        </label>
        <label className="check">
          <input type="checkbox" checked={s.timestamps} onChange={(e) => s.set({ timestamps: e.target.checked })} /> Time
        </label>
        <label className="check">
          <input type="checkbox" checked={s.autoscroll} onChange={(e) => s.set({ autoscroll: e.target.checked })} /> Auto-scroll
        </label>
        <button className="icon-btn" title={s.paused ? 'Resume' : 'Pause view (data is still recorded)'} onClick={() => s.set({ paused: !s.paused })}>
          {s.paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
        <button className="icon-btn" title="Clear" onClick={() => s.clear()}>
          <Trash2 size={13} />
        </button>
        <button className="icon-btn" title="Export log" onClick={exportLog}>
          <Download size={13} />
        </button>
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 11 }}>
          {s.status.open ? `${s.status.port?.replace('/dev/', '')} · ${s.status.bytesIn} B in` : s.status.error ? <span className="sev-warning">{s.status.error}</span> : 'closed'}
        </span>
        <button className="btn sm ghost" title="Ask the Copilot to analyse recent serial output" disabled={serialBuffer.lines.length === 0} onClick={() => void useAi.getState().run('Analysing serial output', () => call('ai.debugSerial', { options: contextOptions() }))}>
          <Bot size={12} /> Debug with AI
        </button>
      </div>
      <div className="console" ref={box} style={{ position: 'relative', whiteSpace: 'normal' }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="serial-output">
        <div style={{ height: lines.length * ROW, position: 'relative' }}>
          <div style={{ position: 'absolute', top: first * ROW, left: 0, right: 0 }}>
            {lines.slice(first, last).map((l, i) => (
              <Line key={`${l.seq}:${first + i}`} line={l} ts={s.timestamps} />
            ))}
          </div>
        </div>
        {serialBuffer.partial && <div className="faint" style={{ height: ROW }}>{serialBuffer.partial}</div>}
        {lines.length === 0 && <div className="faint">{s.status.open ? 'Waiting for data…' : 'Connect to a port to see serial output.'}</div>}
      </div>
      <div className="toolbar" style={{ borderTop: '1px solid var(--border)', borderBottom: 0 }}>
        <input
          className="input grow mono"
          style={{ height: 24 }}
          placeholder={s.status.open ? 'Send to device (Enter, ↑ for history)' : 'Not connected'}
          disabled={!s.status.open}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
            else if (e.key === 'ArrowUp' && hist.length) {
              const i = Math.min(hist.length - 1, histIdx + 1);
              setHistIdx(i);
              setInput(hist[i]!);
            } else if (e.key === 'ArrowDown') {
              const i = Math.max(-1, histIdx - 1);
              setHistIdx(i);
              setInput(i < 0 ? '' : hist[i]!);
            }
          }}
          data-testid="serial-input"
        />
        <select className="select" style={{ height: 24 }} value={s.lineEnding} onChange={(e) => s.set({ lineEnding: e.target.value as LineEnding })} title="Line ending">
          <option value="none">No line ending</option>
          <option value="lf">LF</option>
          <option value="cr">CR</option>
          <option value="crlf">CR+LF</option>
        </select>
        <button className="btn sm" disabled={!s.status.open} onClick={send}>
          Send
        </button>
      </div>
    </>
  );
}
