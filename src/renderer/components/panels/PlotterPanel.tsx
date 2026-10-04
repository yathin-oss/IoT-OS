import { Pause, Play, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { plotter, useSerial } from '../../state/runtime';

const COLORS = ['#3e8ef7', '#30a46c', '#f5a524', '#e5484d', '#8e4ec6', '#12a594', '#e54666', '#ad7f58'];

/**
 * Real-time Serial Plotter. Parses the documented telemetry formats (see
 * docs/SERIAL.md) from the live serial stream.
 */
export function PlotterPanel() {
  const { plotVersion, plotPaused, set, clearPlot, status } = useSerial();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [windowSize, setWindowSize] = useState(300);
  const [auto, setAuto] = useState(true);
  const [range, setRange] = useState({ min: 0, max: 1023 });
  const names = plotter.series.names();

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const raf = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      c.width = w * dpr;
      c.height = h * dpr;
      const g = c.getContext('2d')!;
      g.scale(dpr, dpr);
      g.clearRect(0, 0, w, h);
      const snap = plotter.series.snapshot();
      const n = Math.min(windowSize, snap.t.length);
      const start = snap.t.length - n;
      let min = Infinity;
      let max = -Infinity;
      for (const [name, vals] of Object.entries(snap.series)) {
        if (hidden.has(name)) continue;
        for (let i = start; i < vals.length; i++) {
          const v = vals[i]!;
          if (Number.isFinite(v)) {
            min = Math.min(min, v);
            max = Math.max(max, v);
          }
        }
      }
      if (!auto) {
        min = range.min;
        max = range.max;
      }
      if (!Number.isFinite(min)) {
        min = 0;
        max = 1;
      }
      if (max === min) {
        max += 1;
        min -= 1;
      }
      const pad = { l: 52, r: 10, t: 10, b: 18 };
      const pw = w - pad.l - pad.r;
      const ph = h - pad.t - pad.b;
      g.strokeStyle = '#262a32';
      g.fillStyle = '#8d94a0';
      g.font = '11px ui-monospace, monospace';
      g.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = pad.t + (ph * i) / 4;
        g.beginPath();
        g.moveTo(pad.l, y);
        g.lineTo(w - pad.r, y);
        g.stroke();
        const val = max - ((max - min) * i) / 4;
        g.fillText(Math.abs(val) >= 1000 || Number.isInteger(val) ? val.toFixed(0) : val.toFixed(2), 4, y + 4);
      }
      Object.entries(snap.series).forEach(([name, vals], si) => {
        if (hidden.has(name)) return;
        g.strokeStyle = COLORS[si % COLORS.length]!;
        g.lineWidth = 1.5;
        g.beginPath();
        let moved = false;
        for (let i = start; i < vals.length; i++) {
          const v = vals[i]!;
          if (!Number.isFinite(v)) {
            moved = false;
            continue;
          }
          const x = pad.l + ((i - start) / Math.max(1, windowSize - 1)) * pw;
          const y = pad.t + ph - ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * ph;
          if (moved) g.lineTo(x, y);
          else g.moveTo(x, y);
          moved = true;
        }
        g.stroke();
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [plotVersion, hidden, windowSize, auto, range]);

  return (
    <>
      <div className="toolbar">
        {names.length === 0 && <span className="faint">{status.open ? 'Waiting for numeric data (e.g. "temp:25.1 hum:40" or "25.1,40")…' : 'Connect the Serial Monitor to plot data.'}</span>}
        {names.map((n, i) => (
          <label key={n} className="check" style={{ color: COLORS[i % COLORS.length] }}>
            <input
              type="checkbox"
              checked={!hidden.has(n)}
              onChange={() =>
                setHidden((h) => {
                  const next = new Set(h);
                  if (next.has(n)) next.delete(n);
                  else next.add(n);
                  return next;
                })
              }
            />
            {n}
          </label>
        ))}
        <span className="spacer" />
        <span className="faint">Window</span>
        <select className="select" style={{ height: 22 }} value={windowSize} onChange={(e) => setWindowSize(Number(e.target.value))}>
          {[100, 300, 1000, 2000].map((w) => (
            <option key={w}>{w}</option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-scale
        </label>
        {!auto && (
          <>
            <input className="input" style={{ width: 70, height: 22 }} type="number" value={range.min} onChange={(e) => setRange({ ...range, min: Number(e.target.value) })} />
            <input className="input" style={{ width: 70, height: 22 }} type="number" value={range.max} onChange={(e) => setRange({ ...range, max: Number(e.target.value) })} />
          </>
        )}
        <button className="icon-btn" title={plotPaused ? 'Resume' : 'Pause'} onClick={() => set({ plotPaused: !plotPaused })}>
          {plotPaused ? <Play size={13} /> : <Pause size={13} />}
        </button>
        <button className="icon-btn" title="Clear" onClick={clearPlot}>
          <Trash2 size={13} />
        </button>
      </div>
      <canvas ref={canvas} style={{ flex: 1, width: '100%', minHeight: 0 }} data-testid="plotter" />
    </>
  );
}
