import { Check, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Proposal } from '../../../core/proposals/proposal';
import { call, errorMessage } from '../../api/client';
import { useEditor } from '../../state/editor';
import { useAi } from '../../state/runtime';
import { useUi } from '../../state/ui';
import { SeverityIcon } from '../panels/SeverityIcon';

/** Reviews a change proposal: per-file and per-block (hunk) accept/reject. */
export function ProposalReview({ id }: { id: string }) {
  const fromStore = useAi((s) => s.proposals.find((p) => p.id === id));
  const [proposal, setProposal] = useState<Proposal | null>(fromStore ?? null);
  const [sel, setSel] = useState<Record<string, Set<number>>>({});
  const [busy, setBusy] = useState(false);
  const ui = useUi();

  useEffect(() => {
    if (fromStore) setProposal(fromStore);
    else void call('proposals.get', { id }).then(setProposal).catch((e: unknown) => ui.toast('error', errorMessage(e)));
  }, [id, fromStore]);

  useEffect(() => {
    if (!proposal) return;
    setSel(Object.fromEntries(proposal.changes.map((c) => [c.path, new Set(c.blocks.map((b) => b.id))])));
  }, [proposal?.id]);

  const selection = useMemo(() => {
    if (!proposal) return {};
    return Object.fromEntries(
      proposal.changes.map((c) => {
        const s = sel[c.path] ?? new Set<number>();
        if (c.kind !== 'modify') return [c.path, s.size > 0 ? 'all' : 'none'];
        return [c.path, s.size === c.blocks.length ? 'all' : s.size === 0 ? 'none' : [...s]];
      }),
    ) as Record<string, 'all' | 'none' | number[]>;
  }, [proposal, sel]);

  if (!proposal) return <div className="empty">Loading proposal…</div>;
  const pending = proposal.status === 'pending';
  const toggle = (path: string, block: number) =>
    setSel((s) => {
      const next = new Set(s[path]);
      if (next.has(block)) next.delete(block);
      else next.add(block);
      return { ...s, [path]: next };
    });
  const setFile = (path: string, all: boolean) => {
    const c = proposal.changes.find((x) => x.path === path)!;
    setSel((s) => ({ ...s, [path]: new Set(all ? c.blocks.map((b) => b.id) : []) }));
  };

  const apply = async (mode: 'selection' | 'all') => {
    setBusy(true);
    try {
      const r = await call('proposals.apply', { id, selection: mode === 'all' ? {} : selection });
      setProposal(r.proposal);
      for (const p of r.written) await useEditor.getState().reload(p).catch(() => undefined);
      ui.toast('success', `Applied ${r.written.length} file(s): ${r.written.join(', ')}`);
    } catch (err) {
      ui.toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    setProposal(await call('proposals.reject', { id }));
    ui.toast('info', 'Proposal rejected; nothing was changed.');
  };

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 1000 }}>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="grow">
            <h2 style={{ margin: 0, fontSize: 16 }}>{proposal.title}</h2>
            <div className="muted selectable" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>
              {proposal.description}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <span className={`badge ${proposal.origin === 'ai' ? 'info' : ''}`}>{proposal.origin === 'ai' ? 'AI proposal' : 'Generated'}</span>
              <span className={`badge ${proposal.status === 'pending' ? 'warn' : proposal.status === 'rejected' ? '' : 'ok'}`}>{proposal.status}</span>
              <span className="faint">{proposal.changes.length} file(s)</span>
            </div>
          </div>
          {pending && (
            <div className="row">
              <button className="btn" onClick={() => void reject()} disabled={busy}>
                <X size={13} /> Reject
              </button>
              <button className="btn" onClick={() => void apply('selection')} disabled={busy}>
                Apply selected
              </button>
              <button className="btn primary" onClick={() => void apply('all')} disabled={busy} data-testid="apply-all">
                <Check size={13} /> Accept all
              </button>
            </div>
          )}
        </div>

        {proposal.notes && proposal.notes.length > 0 && (
          <div className="card selectable" style={{ padding: 10, marginTop: 12 }}>
            <b>Notes &amp; assumptions</b>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {proposal.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        )}
        {proposal.diagnostics.filter((d) => d.severity !== 'info').length > 0 && (
          <div className="card" style={{ padding: 10, marginTop: 12 }}>
            <b>Validation of the proposed hardware</b>
            {proposal.diagnostics
              .filter((d) => d.severity !== 'info')
              .map((d, i) => (
                <div key={i} className="row selectable" style={{ alignItems: 'flex-start', marginTop: 4 }}>
                  <SeverityIcon severity={d.severity} />
                  <span>
                    {d.message}
                    {d.hint && <span className="muted"> — {d.hint}</span>}
                  </span>
                </div>
              ))}
          </div>
        )}

        {proposal.changes.map((c) => (
          <div key={c.path} style={{ marginTop: 16 }}>
            <div className="row">
              <span className="mono" style={{ fontWeight: 600 }}>
                {c.path}
              </span>
              <span className="badge">{c.kind}</span>
              <span className="badge">{c.category}</span>
              <span className="spacer" />
              {pending && (
                <>
                  <button className="btn sm ghost" onClick={() => setFile(c.path, true)}>
                    Select all
                  </button>
                  <button className="btn sm ghost" onClick={() => setFile(c.path, false)}>
                    None
                  </button>
                </>
              )}
            </div>
            {c.summary.length > 0 && (
              <ul className="muted" style={{ margin: '4px 0', paddingLeft: 18 }}>
                {c.summary.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            )}
            {c.blocks.map((b) => (
              <div key={b.id} className="diff-block">
                <div className="diff-block-head">
                  {pending && <input type="checkbox" checked={sel[c.path]?.has(b.id) ?? false} onChange={() => toggle(c.path, b.id)} aria-label={`Accept change ${b.id + 1}`} />}
                  <span className="muted">
                    Change {b.id + 1} · line {b.oldStart}
                    {b.removed.length ? ` · −${b.removed.length}` : ''}
                    {b.added.length ? ` · +${b.added.length}` : ''}
                  </span>
                </div>
                {b.removed.map((l, i) => (
                  <div key={`d${i}`} className="diff-line del">
                    − {l}
                  </div>
                ))}
                {b.added.map((l, i) => (
                  <div key={`a${i}`} className="diff-line add">
                    + {l}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
