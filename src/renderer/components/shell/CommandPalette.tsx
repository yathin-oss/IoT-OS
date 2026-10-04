import { useEffect, useMemo, useRef, useState } from 'react';
import { COMMANDS, displayKeys, runCommand } from '../../commands';
import { useProject } from '../../state/project';
import { useUi } from '../../state/ui';

function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return 100 - t.indexOf(q);
  // Subsequence match
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 10 : 0;
}

export function CommandPalette() {
  const { paletteOpen, setPalette } = useUi();
  const hasProject = useProject((s) => s.snapshot !== null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const items = useMemo(
    () =>
      COMMANDS.map((c) => ({ c, s: score(q, `${c.category} ${c.title}`) }))
        .filter((x) => x.s > 0 && (hasProject || !x.c.needsProject))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.c),
    [q, hasProject],
  );
  useEffect(() => {
    if (paletteOpen) {
      setQ('');
      setSel(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [paletteOpen]);
  if (!paletteOpen) return null;
  const run = (id: string) => {
    setPalette(false);
    runCommand(id);
  };
  return (
    <div className="overlay" onMouseDown={() => setPalette(false)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          ref={input}
          autoFocus
          value={q}
          placeholder="Type a command…"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPalette(false);
            else if (e.key === 'ArrowDown') setSel((s) => Math.min(items.length - 1, s + 1));
            else if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
            else if (e.key === 'Enter' && items[sel]) run(items[sel].id);
            else return;
            e.preventDefault();
          }}
        />
        <div className="items">
          {items.map((c, i) => (
            <div key={c.id} className={`item${i === sel ? ' sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => run(c.id)}>
              <span className="cat">{c.category}</span>
              <span className="grow">{c.title}</span>
              {c.keys && <span className="kbd">{displayKeys(c.keys)}</span>}
            </div>
          ))}
          {items.length === 0 && <div className="empty">No matching commands</div>}
        </div>
      </div>
    </div>
  );
}
