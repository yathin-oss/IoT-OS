import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { boardGeometry, boardPinPosition, componentGeometry, snap, type Point } from '../../../core/circuit/geometry';
import { addComponent, connect, disconnect, duplicateComponents, moveComponent, removeComponents, rotateComponent } from '../../../core/circuit/operations';
import { wireColor } from '../../../core/circuit/layout';
import type { Diagnostic } from '../../../core/diagnostics';
import { BOARD_NODE, type Circuit, type ComponentInstance, type Endpoint } from '../../../core/project/schema';
import { getRegistry, isGpio } from '../../../core/registry/registry';
import type { BoardDefinition, ComponentDefinition } from '../../../core/registry/types';
import type { ComponentSimState } from '../../../core/sim/types';
import { useCircuit } from '../../state/circuit';
import { useUi } from '../../state/ui';
import { useSim } from './simStore';

export const PALETTE_MIME = 'application/x-iotos-component';

interface View {
  x: number;
  y: number;
  k: number;
}

type Drag =
  | { kind: 'move'; id: string; start: Point; orig: Point; base: Circuit; moved: boolean }
  | { kind: 'pan'; start: Point; orig: View }
  | null;

const LED_COLORS: Record<string, string> = { red: '#ff4d4d', green: '#3ddc84', blue: '#4d8dff', yellow: '#ffd23f', white: '#f5f5f5' };

function pinKind(board: BoardDefinition, id: string): 'power' | 'ground' | 'gpio' | 'control' {
  const p = getRegistry().resolveBoardPin(board.id, id);
  if (isGpio(p)) return 'gpio';
  return p?.kind === 'ground' ? 'ground' : p?.kind === 'power' ? 'power' : 'control';
}

function BoardView({ board, origin, selected, diagnosticsPins, pinStates, onPin, pendingPin }: {
  board: BoardDefinition;
  origin: Point;
  selected: boolean;
  diagnosticsPins: Map<string, Diagnostic['severity']>;
  pinStates: Record<string, { mode: string; level: number; duty: number }> | undefined;
  onPin: (pin: string, e: React.MouseEvent) => void;
  pendingPin: string | null;
}) {
  const g = boardGeometry(board, origin);
  return (
    <g data-node="board">
      <rect x={origin.x} y={origin.y} width={g.width} height={g.height} rx={8} fill="#1a3a2a" stroke={selected ? '#3e8ef7' : '#2f5a44'} strokeWidth={selected ? 2 : 1} data-drag="board" />
      <rect x={origin.x + 45} y={origin.y + 14} width={80} height={22} rx={3} fill="#0d0f12" stroke="#333" data-drag="board" />
      <text x={origin.x + g.width / 2} y={origin.y + 29} textAnchor="middle" fill="#9aa3b2" fontSize={9} pointerEvents="none">
        {board.mcu.split(' ')[0]}
      </text>
      <text x={origin.x + g.width / 2} y={origin.y + g.height - 6} textAnchor="middle" fill="#7fc3a0" fontSize={9.5} pointerEvents="none">
        {board.name.split(' (')[0]}
      </text>
      {g.pins.map((p) => {
        const kind = pinKind(board, p.id);
        const st = pinStates?.[p.id];
        const active = st && st.mode === 'output' && (st.level === 1 || st.duty > 0.05);
        const sev = diagnosticsPins.get(p.id);
        const fill = active ? '#ffcf4d' : kind === 'power' ? '#e5484d' : kind === 'ground' ? '#5b6170' : kind === 'control' ? '#8e4ec6' : '#c9a227';
        const label = getRegistry().resolveBoardPin(board.id, p.id)?.label ?? p.id;
        return (
          <g key={`${p.side}${p.index}`}>
            <rect
              className="pin-dot"
              x={p.x - 5}
              y={p.y - 5}
              width={10}
              height={10}
              rx={2}
              fill={fill}
              stroke={pendingPin === p.id ? '#3e8ef7' : sev === 'error' || sev === 'blocking' ? '#ef5350' : sev === 'warning' ? '#e5a50a' : '#0b0d10'}
              strokeWidth={pendingPin === p.id || sev ? 2 : 1}
              onMouseDown={(e) => {
                e.stopPropagation();
                onPin(p.id, e);
              }}
              data-pin={`board.${p.id}`}
            >
              <title>{`${label} (${p.id})`}</title>
            </rect>
            <text x={p.side === 'left' ? p.x + 9 : p.x - 9} y={p.y + 3} textAnchor={p.side === 'left' ? 'start' : 'end'} fill="#c9d4cc" fontSize={8.5} pointerEvents="none">
              {label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function ComponentBody({ inst, def, sim, onPress }: { inst: ComponentInstance; def: ComponentDefinition; sim: ComponentSimState | undefined; onPress: (down: boolean) => void }) {
  const { width: w, height: h } = def.visual;
  const cx = inst.x + w / 2;
  const cy = inst.y + h / 2;
  const tf = inst.rotation ? `rotate(${inst.rotation} ${cx} ${cy})` : undefined;
  switch (def.visual.shape) {
    case 'led': {
      const color = LED_COLORS[String(inst.props['color'])] ?? '#ff4d4d';
      const lit = sim?.kind === 'led' && sim.on ? sim.brightness : 0;
      return (
        <g transform={tf}>
          {lit > 0 && <circle cx={cx} cy={inst.y + 20} r={24} fill={color} opacity={0.15 + 0.35 * lit} filter="url(#glow)" />}
          <path d={`M ${cx - 12} ${inst.y + 34} L ${cx - 12} ${inst.y + 18} A 12 12 0 0 1 ${cx + 12} ${inst.y + 18} L ${cx + 12} ${inst.y + 34} Z`} fill={color} opacity={0.35 + 0.65 * lit} stroke="#000" strokeOpacity={0.4} data-drag={inst.id} data-lit={lit > 0 ? '1' : '0'} data-testid={`led-${inst.id}`} />
          <rect x={cx - 14} y={inst.y + 34} width={28} height={4} fill={color} opacity={0.6} data-drag={inst.id} />
          <line x1={inst.x + w / 3} y1={inst.y + 38} x2={inst.x + w / 3} y2={inst.y + h} stroke="#aaa" strokeWidth={1.5} />
          <line x1={inst.x + (2 * w) / 3} y1={inst.y + 38} x2={inst.x + (2 * w) / 3} y2={inst.y + h} stroke="#aaa" strokeWidth={1.5} />
        </g>
      );
    }
    case 'resistor':
      return (
        <g transform={tf}>
          <line x1={inst.x} y1={cy} x2={inst.x + w} y2={cy} stroke="#aaa" strokeWidth={1.5} />
          <rect x={inst.x + 18} y={cy - 7} width={w - 36} height={14} rx={6} fill="#d8c193" data-drag={inst.id} />
          {[0.3, 0.45, 0.6, 0.78].map((f, i) => (
            <rect key={i} x={inst.x + 18 + (w - 36) * f - 2} y={cy - 7} width={4} height={14} fill={['#a0522d', '#000', '#a0522d', '#c9a227'][i]} pointerEvents="none" />
          ))}
        </g>
      );
    case 'button': {
      const pressed = sim?.kind === 'button' && sim.pressed;
      return (
        <g transform={tf}>
          <rect x={inst.x + 5} y={inst.y + 2} width={w - 10} height={h - 12} rx={4} fill="#2b2f36" stroke="#555" data-drag={inst.id} />
          <circle
            cx={cx}
            cy={inst.y + (h - 10) / 2 + 2}
            r={pressed ? 9 : 11}
            fill={pressed ? '#a83232' : '#d94242'}
            style={{ cursor: 'pointer' }}
            onMouseDown={(e) => {
              if (useSim.getState().running) {
                e.stopPropagation();
                onPress(true);
              }
            }}
            onMouseUp={() => useSim.getState().running && onPress(false)}
            onMouseLeave={() => pressed && onPress(false)}
            data-drag={inst.id}
            data-testid={`button-${inst.id}`}
          />
        </g>
      );
    }
    case 'breadboard':
      return (
        <g transform={tf}>
          <rect x={inst.x} y={inst.y} width={w} height={h} rx={4} fill="#e9e6dc" opacity={0.12} stroke="#888" strokeOpacity={0.4} data-drag={inst.id} />
          {Array.from({ length: 30 }, (_, i) =>
            Array.from({ length: 10 }, (_, j) => <rect key={`${i}:${j}`} x={inst.x + 10 + i * 10.7} y={inst.y + 14 + j * 9.5 + (j >= 5 ? 6 : 0)} width={3} height={3} fill="#666" pointerEvents="none" />),
          )}
        </g>
      );
    default: {
      let status: string | null = null;
      let highlight = false;
      if (sim?.kind === 'servo') status = sim.angle === null ? 'no signal' : `${sim.angle}°`;
      if (sim?.kind === 'relay') {
        status = sim.energized ? 'ON' : 'off';
        highlight = sim.energized;
      }
      if (sim?.kind === 'buzzer') {
        status = sim.on ? (sim.freqHz > 20 ? `${Math.round(sim.freqHz)} Hz` : 'beep') : 'silent';
        highlight = sim.on;
      }
      if (sim?.kind === 'analog') status = `${sim.volts.toFixed(2)} V`;
      if (sim?.kind === 'digital') {
        status = sim.high ? 'HIGH' : 'LOW';
        highlight = sim.high;
      }
      return (
        <g transform={tf}>
          <rect x={inst.x} y={inst.y} width={w} height={h - 8} rx={4} fill={def.visual.color ?? '#2b3a55'} stroke={highlight ? '#ffcf4d' : '#000'} strokeOpacity={highlight ? 1 : 0.5} strokeWidth={highlight ? 2 : 1} data-drag={inst.id} />
          <text x={cx} y={inst.y + 15} textAnchor="middle" fill="#fff" fontSize={9} opacity={0.85} pointerEvents="none">
            {(def.name.split(' (')[0] ?? def.name).slice(0, Math.floor(w / 5.2))}
          </text>
          {sim?.kind === 'servo' && sim.angle !== null && (
            <line x1={cx} y1={inst.y + (h - 8) / 2 + 4} x2={cx + Math.cos(((sim.angle - 90) * Math.PI) / 180) * 18} y2={inst.y + (h - 8) / 2 + 4 + Math.sin(((sim.angle - 90) * Math.PI) / 180) * 18} stroke="#fff" strokeWidth={3} strokeLinecap="round" pointerEvents="none" />
          )}
          {status && (
            <text x={cx} y={inst.y + h - 14} textAnchor="middle" fill={highlight ? '#ffcf4d' : '#d5d9e0'} fontSize={9} fontFamily="monospace" pointerEvents="none">
              {status}
            </text>
          )}
          {sim?.kind === 'unsupported' && (
            <text x={cx} y={inst.y + h - 14} textAnchor="middle" fill="#8d94a0" fontSize={8} pointerEvents="none">
              not simulated
            </text>
          )}
        </g>
      );
    }
  }
}

function wirePath(a: Point, b: Point, points?: Point[]): string {
  if (points?.length) return `M ${a.x} ${a.y} ${points.map((p) => `L ${p.x} ${p.y}`).join(' ')} L ${b.x} ${b.y}`;
  const mx = snap((a.x + b.x) / 2);
  return `M ${a.x} ${a.y} L ${mx} ${a.y} L ${mx} ${b.y} L ${b.x} ${b.y}`;
}

export function CircuitCanvas({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const { history, hardware, selection, apply, commitTransient, select, undo, redo } = useCircuit();
  const focus = useUi((s) => s.focusComponent);
  const sim = useSim();
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>({ x: -60, y: -60, k: 1 });
  const [drag, setDrag] = useState<Drag>(null);
  const [pending, setPending] = useState<Endpoint | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [size, setSize] = useState({ w: 1000, h: 600 });
  const circuit = history?.present ?? null;
  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(1, el.clientWidth), h: Math.max(1, el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [circuit !== null]);
  const reg = getRegistry();
  const board = hardware ? reg.getBoard(hardware.boardId) : undefined;

  const toWorld = useCallback(
    (clientX: number, clientY: number): Point => {
      const r = svgRef.current!.getBoundingClientRect();
      return { x: (clientX - r.left) / view.k + view.x, y: (clientY - r.top) / view.k + view.y };
    },
    [view],
  );

  const endpointPos = useCallback(
    (e: Endpoint, near?: Point): Point | null => {
      if (!circuit || !board) return null;
      if (e.node === BOARD_NODE) return boardPinPosition(boardGeometry(board, circuit.board), reg.resolveBoardPin(board.id, e.pin)?.id ?? e.pin, near);
      const inst = circuit.components.find((c) => c.id === e.node);
      const def = inst ? reg.getComponent(inst.type) : undefined;
      if (!inst || !def) return null;
      const p = componentGeometry(inst, def).pins.find((x) => x.id === e.pin);
      return p ? { x: p.x, y: p.y } : null;
    },
    [circuit, board, reg],
  );

  // Fit view on first load / board change.
  useEffect(() => {
    if (!circuit || !board || !svgRef.current) return;
    const g = boardGeometry(board, circuit.board);
    let maxX = circuit.board.x + g.width;
    let maxY = circuit.board.y + g.height;
    for (const c of circuit.components) {
      const d = reg.getComponent(c.type);
      maxX = Math.max(maxX, c.x + (d?.visual.width ?? 60));
      maxY = Math.max(maxY, c.y + (d?.visual.height ?? 60));
    }
    const r = svgRef.current.getBoundingClientRect();
    const k = Math.max(0.3, Math.min(1.6, Math.min(r.width / (maxX - circuit.board.x + 160), r.height / (maxY - circuit.board.y + 160))));
    setView({ x: circuit.board.x - 80, y: circuit.board.y - 60, k });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board?.id]);

  useEffect(() => {
    if (focus && circuit) {
      const c = circuit.components.find((x) => x.id === focus.id);
      if (c && svgRef.current) {
        const r = svgRef.current.getBoundingClientRect();
        setView((v) => ({ ...v, x: c.x - r.width / v.k / 2, y: c.y - r.height / v.k / 2 }));
        select([c.id]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // Keyboard shortcuts when the canvas has focus.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!circuit) return;
    const mod = e.metaKey || e.ctrlKey;
    const ids = selection.filter((s) => s !== BOARD_NODE);
    if (e.key === ' ') setSpaceDown(true);
    if (e.key === 'Escape') {
      setPending(null);
      select([]);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length) {
      const wireIds = selection.filter((s) => circuit.wires.some((w) => w.id === s));
      apply((c) => disconnect(removeComponents(c, ids), wireIds));
      select([]);
    } else if (e.key.toLowerCase() === 'r' && !mod && ids.length) {
      apply((c) => ids.filter((id) => c.components.some((x) => x.id === id)).reduce((acc, id) => rotateComponent(acc, id, e.shiftKey ? -90 : 90), c));
    } else if (e.key.toLowerCase() === 'd' && mod && ids.length) {
      let newIds: string[] = [];
      apply((c) => {
        const r = duplicateComponents(c, ids);
        newIds = Object.values(r.idMap);
        return r.circuit;
      });
      select(newIds);
    } else if (e.key.toLowerCase() === 'z' && mod) {
      if (e.shiftKey) redo();
      else undo();
    } else if (e.key.toLowerCase() === 'y' && mod) redo();
    else return;
    e.preventDefault();
  };

  const onPin = (node: string, pin: string) => {
    if (sim.running) return;
    const ep: Endpoint = { node, pin };
    if (!pending) {
      setPending(ep);
      return;
    }
    if (pending.node === ep.node && pending.pin === ep.pin) {
      setPending(null);
      return;
    }
    const bp = [pending, ep].find((x) => x.node === BOARD_NODE);
    const kind = bp && board ? pinKind(board, bp.pin) : 'gpio';
    const color = wireColor(kind === 'ground' ? 'ground' : kind === 'power' ? 'power' : 'signal', circuit?.wires.length ?? 0);
    apply((c) => connect(c, pending, ep, { color }).circuit);
    setPending(null);
  };

  const diagByComponent = useMemo(() => {
    const m = new Map<string, Diagnostic['severity']>();
    const pins = new Map<string, Diagnostic['severity']>();
    const rank = { info: 0, warning: 1, error: 2, blocking: 3 };
    for (const d of diagnostics) {
      if (d.severity === 'info') continue;
      const id = d.target?.componentId;
      if (id && (!m.has(id) || rank[d.severity] > rank[m.get(id)!])) m.set(id, d.severity);
      const bp = d.target?.boardPin;
      if (bp && (!pins.has(bp) || rank[d.severity] > rank[pins.get(bp)!])) pins.set(bp, d.severity);
    }
    return { comps: m, pins };
  }, [diagnostics]);

  if (!circuit || !board) return <div className="empty">No circuit loaded.</div>;
  const simComp = sim.snapshot?.components;
  const pendingPos = pending ? endpointPos(pending) : null;

  return (
    <div
      className={`sim-canvas${drag?.kind === 'pan' ? ' panning' : ''}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => e.key === ' ' && setSpaceDown(false)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(PALETTE_MIME)) e.preventDefault();
      }}
      onDrop={(e) => {
        const type = e.dataTransfer.getData(PALETTE_MIME);
        if (!type || sim.running) return;
        e.preventDefault();
        const p = toWorld(e.clientX, e.clientY);
        let id = '';
        apply((c) => {
          const r = addComponent(c, type, { x: p.x - 20, y: p.y - 20 });
          id = r.id;
          return r.circuit;
        });
        select([id]);
      }}
      data-testid="circuit-canvas"
    >
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${size.w / view.k} ${size.h / view.k}`}
        onWheel={(e) => {
          const p = toWorld(e.clientX, e.clientY);
          const k = Math.max(0.2, Math.min(4, view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
          setView({ k, x: p.x - (p.x - view.x) * (view.k / k), y: p.y - (p.y - view.y) * (view.k / k) });
        }}
        onMouseDown={(e) => {
          (e.currentTarget.parentElement as HTMLElement).focus();
          const target = e.target as Element;
          const dragId = target.getAttribute('data-drag');
          if (e.button === 1 || spaceDown || (!dragId && e.button === 0)) {
            if (!dragId && e.button === 0 && !spaceDown) {
              select([]);
              setPending(null);
            }
            setDrag({ kind: 'pan', start: { x: e.clientX, y: e.clientY }, orig: view });
            return;
          }
          if (dragId) {
            const id = dragId === 'board' ? BOARD_NODE : dragId;
            if (!selection.includes(id)) select(e.shiftKey ? [...selection, id] : [id]);
            if (sim.running) return;
            const orig = id === BOARD_NODE ? circuit.board : circuit.components.find((c) => c.id === id)!;
            setDrag({ kind: 'move', id, start: toWorld(e.clientX, e.clientY), orig: { x: orig.x, y: orig.y }, base: circuit, moved: false });
          }
        }}
        onMouseMove={(e) => {
          if (pending) setCursor(toWorld(e.clientX, e.clientY));
          if (!drag) return;
          if (drag.kind === 'pan') {
            setView({ ...drag.orig, x: drag.orig.x - (e.clientX - drag.start.x) / view.k, y: drag.orig.y - (e.clientY - drag.start.y) / view.k });
          } else {
            const p = toWorld(e.clientX, e.clientY);
            const to = { x: drag.orig.x + p.x - drag.start.x, y: drag.orig.y + p.y - drag.start.y };
            apply((c) => moveComponent(c, drag.id, to), { transient: true });
            if (!drag.moved) setDrag({ ...drag, moved: true });
          }
        }}
        onMouseUp={() => {
          if (drag?.kind === 'move' && drag.moved) commitTransient(drag.base);
          setDrag(null);
        }}
        onMouseLeave={() => {
          if (drag?.kind === 'move' && drag.moved) commitTransient(drag.base);
          setDrag(null);
        }}
      >
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>
        <BoardView
          board={board}
          origin={circuit.board}
          selected={selection.includes(BOARD_NODE)}
          diagnosticsPins={diagByComponent.pins}
          pinStates={sim.snapshot?.pins}
          onPin={(pin) => onPin(BOARD_NODE, pin)}
          pendingPin={pending?.node === BOARD_NODE ? pending.pin : null}
        />
        {circuit.wires.map((w) => {
          const a = endpointPos(w.from);
          const b = endpointPos(w.to, a ?? undefined);
          const a2 = w.from.node === BOARD_NODE && b ? endpointPos(w.from, b) : a;
          if (!a2 || !b) return null;
          const sel = selection.includes(w.id);
          return (
            <g key={w.id}>
              <path d={wirePath(a2, b, w.points)} fill="none" stroke="transparent" strokeWidth={10} style={{ cursor: 'pointer' }} onMouseDown={(e) => {
                e.stopPropagation();
                select([w.id]);
              }} />
              <path d={wirePath(a2, b, w.points)} fill="none" stroke={w.color ?? '#3e8ef7'} strokeWidth={sel ? 3 : 2} strokeOpacity={sel ? 1 : 0.85} pointerEvents="none" strokeLinejoin="round" />
            </g>
          );
        })}
        {circuit.components.map((inst) => {
          const def = reg.getComponent(inst.type);
          if (!def) return null;
          const geo = componentGeometry(inst, def);
          const sel = selection.includes(inst.id);
          const sev = diagByComponent.comps.get(inst.id);
          const stimulus = def.sim.stimulus;
          return (
            <g key={inst.id} data-component={inst.id}>
              {sel && <rect x={inst.x - 6} y={inst.y - 6} width={def.visual.width + 12} height={def.visual.height + 12} rx={6} fill="none" stroke="#3e8ef7" strokeDasharray="4 3" pointerEvents="none" transform={inst.rotation ? `rotate(${inst.rotation} ${inst.x + def.visual.width / 2} ${inst.y + def.visual.height / 2})` : undefined} />}
              <ComponentBody inst={inst} def={def} sim={simComp?.[inst.id]} onPress={(down) => stimulus && sim.stimulus(inst.id, stimulus, down)} />
              <text x={inst.x + def.visual.width / 2} y={inst.y - 9} textAnchor="middle" fill={sev === 'error' || sev === 'blocking' ? '#ef5350' : sev === 'warning' ? '#e5a50a' : '#9aa3b2'} fontSize={10} fontWeight={600} pointerEvents="none">
                {inst.label}
                {sev && sev !== 'info' ? ' ⚠' : ''}
              </text>
              {geo.pins.map((p) => {
                const isPending = pending?.node === inst.id && pending.pin === p.id;
                const pd = def.pins.find((x) => x.id === p.id)!;
                return (
                  <g key={p.id}>
                    <circle
                      className="pin-dot"
                      cx={p.x}
                      cy={p.y}
                      r={4.5}
                      fill={pd.role === 'power' ? '#e5484d' : pd.role === 'ground' ? '#5b6170' : '#c9a227'}
                      stroke={isPending ? '#3e8ef7' : '#0b0d10'}
                      strokeWidth={isPending ? 2.5 : 1}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        onPin(inst.id, p.id);
                      }}
                      data-pin={`${inst.id}.${p.id}`}
                    >
                      <title>{`${inst.label}.${pd.label}`}</title>
                    </circle>
                    {def.visual.shape === 'module' && (
                      <text x={p.x} y={p.y + 13} textAnchor="middle" fill="#8d94a0" fontSize={7.5} pointerEvents="none">
                        {p.id}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
        {pending && pendingPos && cursor && <path d={wirePath(pendingPos, cursor)} fill="none" stroke="#3e8ef7" strokeDasharray="5 4" strokeWidth={2} pointerEvents="none" />}
      </svg>
      <div className="sim-banner">
        {pending && <span className="badge accent">Wiring from {pending.node}.{pending.pin} — click another pin (Esc to cancel)</span>}
        {sim.snapshot?.errors.map((e) => (
          <span key={e} className="badge err">
            {e}
          </span>
        ))}
      </div>
      <div style={{ position: 'absolute', right: 8, bottom: 6, background: 'var(--bg-1)', padding: '2px 6px', borderRadius: 4, fontSize: 11 }} className="faint">
        {Math.round(view.k * 100)}% · drag background to pan · wheel to zoom · R rotate · ⌘/Ctrl+D duplicate · Del delete
      </div>
    </div>
  );
}
