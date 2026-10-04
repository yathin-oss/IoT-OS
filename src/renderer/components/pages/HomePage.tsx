import { CircuitBoard, Copy, FolderOpen, LayoutGrid, List, Pin, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getRegistry } from '../../../core/registry/registry';
import { LANGUAGE_LABELS } from '../../../core/registry/types';
import { TEMPLATES } from '../../../core/templates/templates';
import { runCommand } from '../../commands';
import { useProject } from '../../state/project';
import { useAi } from '../../state/runtime';
import { useUi } from '../../state/ui';
import { projectActions } from '../views/ProjectsView';

type Filter = 'all' | 'pinned' | 'recent' | 'templates';

function relTime(iso: string | null): string {
  if (!iso) return '';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

export function HomePage() {
  const { list, refreshList, snapshot } = useProject();
  const ai = useAi((s) => s.status);
  const ui = useUi();
  const [idea, setIdea] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  useEffect(() => {
    void refreshList();
  }, [refreshList]);
  const projects = useMemo(() => {
    const q = query.toLowerCase();
    let l = list.filter((p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || (p.boardId ?? '').includes(q));
    if (filter === 'pinned') l = l.filter((p) => p.pinned);
    if (filter === 'recent') l = l.filter((p) => p.lastOpenedAt).sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '')).slice(0, 12);
    return l;
  }, [list, filter, query]);
  const reg = getRegistry();

  return (
    <div className="page" data-testid="home">
      <div className="page-inner">
        <div className="home-hero">
          <h1>Describe your IoT idea</h1>
          <div className="muted">IoT-OS designs the hardware, validates the wiring, generates firmware and docs — then you review everything before it is created.</div>
          <div className="idea-box">
            <textarea
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              placeholder="e.g. Smart plant monitor on an ESP32 with soil moisture, temperature/humidity, an OLED display and automatic watering"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && idea.trim()) ui.setDialog({ kind: 'ai-builder', idea });
              }}
              data-testid="idea-input"
            />
            <div className="row">
              <span className="faint grow">{ai?.configured ? `Using ${ai.message}` : 'AI provider not configured — add a key in Settings. Everything else works without AI.'}</span>
              <button className="btn" onClick={() => ui.setDialog({ kind: 'new-project', template: 'empty' })} title="Start an empty project and design the circuit in the simulator">
                <CircuitBoard size={14} /> Simulate Hardware
              </button>
              <button className="btn primary" disabled={!idea.trim()} onClick={() => ui.setDialog({ kind: 'ai-builder', idea })}>
                <Sparkles size={14} /> Build with AI
              </button>
            </div>
          </div>
          <div className="row" style={{ marginTop: 14, gap: 8 }}>
            <button className="btn" onClick={() => runCommand('project.new')} data-testid="home-create">
              <Plus size={14} /> Create Project
            </button>
            <button className="btn" onClick={() => runCommand('project.open')}>
              <FolderOpen size={14} /> Open Project
            </button>
            {snapshot && (
              <button className="btn ghost" onClick={() => ui.openTab({ id: 'simulator', kind: 'simulator', title: 'Simulator' })}>
                Continue with {snapshot.manifest.name}
              </button>
            )}
            <span className="spacer" />
            <button className="btn ghost" onClick={() => runCommand('setup.open')}>
              Environment setup check
            </button>
          </div>
        </div>

        <div className="row" style={{ marginTop: 28, marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>Projects</h3>
          <div className="row" style={{ gap: 2, marginLeft: 12 }}>
            {(['all', 'pinned', 'recent', 'templates'] as Filter[]).map((f) => (
              <button key={f} className={`btn sm ${filter === f ? '' : 'ghost'}`} onClick={() => setFilter(f)}>
                {f[0]!.toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <input className="input" style={{ width: 220 }} placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className={`icon-btn${layout === 'grid' ? ' active' : ''}`} onClick={() => setLayout('grid')} title="Cards">
            <LayoutGrid size={14} />
          </button>
          <button className={`icon-btn${layout === 'list' ? ' active' : ''}`} onClick={() => setLayout('list')} title="List">
            <List size={14} />
          </button>
        </div>

        {filter === 'templates' ? (
          <div className="gallery">
            {TEMPLATES.map((t) => (
              <div key={t.id} className="proj-card" onClick={() => ui.setDialog({ kind: 'new-project', template: t.id, boardId: t.defaultBoard })}>
                <div className="title">{t.name}</div>
                <div className="desc">{t.description}</div>
                <div className="row" style={{ marginTop: 'auto', flexWrap: 'wrap', gap: 4 }}>
                  {t.languages.map((l) => (
                    <span key={l} className="badge">
                      {LANGUAGE_LABELS[l]}
                    </span>
                  ))}
                  <span className="badge accent">{reg.getBoard(t.defaultBoard)?.name.split(' (')[0]}</span>
                </div>
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="card empty">{list.length === 0 ? 'No projects yet. Describe an idea above, create a project, or start from a template.' : 'No matching projects.'}</div>
        ) : layout === 'grid' ? (
          <div className="gallery">
            {projects.map((p) => {
              const a = projectActions(p);
              return (
                <div key={p.root} className="proj-card" onClick={a.open} title={p.root} data-testid={`project-card-${p.name}`}>
                  <div className="title">
                    {p.pinned && <Pin size={11} className="muted" />}
                    <span className="ellipsis grow">{p.name}</span>
                    {p.status === 'error' && <span className="badge err">error</span>}
                  </div>
                  <div className="desc">{p.status === 'error' ? p.error : p.description || 'No description'}</div>
                  <div className="row" style={{ marginTop: 'auto', gap: 4, flexWrap: 'wrap' }}>
                    {p.boardId && <span className="badge accent">{reg.getBoard(p.boardId)?.name.split(' (')[0] ?? p.boardId}</span>}
                    {p.language && <span className="badge">{LANGUAGE_LABELS[p.language]}</span>}
                    <span className="badge">{p.componentCount} parts</span>
                    {p.tags.includes('ai-generated') && <span className="badge info">AI</span>}
                    <span className="spacer" />
                    <span className="faint" style={{ fontSize: 11 }}>
                      {relTime(p.updatedAt)}
                    </span>
                  </div>
                  <div className="row" style={{ gap: 0, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" title={p.pinned ? 'Unpin' : 'Pin'} onClick={a.pin}>
                      <Pin size={12} />
                    </button>
                    <button className="icon-btn" title="Duplicate" onClick={a.duplicate} disabled={p.status === 'error'}>
                      <Copy size={12} />
                    </button>
                    <button className="icon-btn" title="Delete" onClick={a.remove}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <table className="table card">
            <thead>
              <tr>
                <th>Name</th>
                <th>Board</th>
                <th>Language</th>
                <th>Parts</th>
                <th>Modified</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.root} className="click" onClick={projectActions(p).open}>
                  <td>
                    {p.pinned ? '📌 ' : ''}
                    {p.name}
                  </td>
                  <td>{p.boardId ? reg.getBoard(p.boardId)?.name ?? p.boardId : '—'}</td>
                  <td>{p.language ? LANGUAGE_LABELS[p.language] : '—'}</td>
                  <td>{p.componentCount}</td>
                  <td className="muted">{relTime(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
