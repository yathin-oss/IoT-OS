import { Bot, FolderOpen, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ProjectPlanPreview } from '../../../core/ipc/contract';
import { getRegistry } from '../../../core/registry/registry';
import { LANGUAGE_LABELS, type Language } from '../../../core/registry/types';
import { TEMPLATES, templateSupports } from '../../../core/templates/templates';
import { call, errorMessage } from '../../api/client';
import { useProject } from '../../state/project';
import { useAi, useApp } from '../../state/runtime';
import { useUi } from '../../state/ui';
import { SeverityIcon } from '../panels/SeverityIcon';

function Modal({ title, icon, onClose, children, footer, wide }: { title: string; icon?: React.ReactNode; onClose: () => void; children: React.ReactNode; footer: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          {icon}
          <span className="grow">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-foot">{footer}</div>
      </div>
    </div>
  );
}

function BoardSelect({ value, onChange, language }: { value: string; onChange: (v: string) => void; language?: Language }) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)} data-testid="board-select">
      {getRegistry()
        .listBoards()
        .filter((b) => !language || b.languages.includes(language))
        .map((b) => (
          <option key={b.id} value={b.id}>
            {b.name} — {b.mcu}
          </option>
        ))}
    </select>
  );
}

function NewProjectDialog({ template: initialTemplate, boardId: initialBoard }: { template?: string; boardId?: string }) {
  const close = () => useUi.getState().setDialog(null);
  const create = useProject((s) => s.create);
  const busy = useProject((s) => s.busy);
  const info = useApp((s) => s.info);
  const settings = useApp((s) => s.settings);
  const [name, setName] = useState('');
  const [boardId, setBoardId] = useState(initialBoard ?? 'esp32-devkit-v1');
  const board = getRegistry().getBoard(boardId)!;
  const [language, setLanguage] = useState<Language>(board.languages[0]!);
  const [template, setTemplate] = useState(initialTemplate ?? 'blink');
  const [parentDir, setParentDir] = useState<string | null>(null);
  const available = TEMPLATES.filter((t) => templateSupports(t, board, language));
  useEffect(() => {
    if (!board.languages.includes(language)) setLanguage(board.languages[0]!);
  }, [board, language]);
  useEffect(() => {
    if (!available.some((t) => t.id === template)) setTemplate(available[0]?.id ?? 'empty');
  }, [available, template]);
  const submit = async () => {
    if (await create({ name: name.trim(), boardId, language, template, ...(parentDir ? { parentDir } : {}) })) close();
  };
  return (
    <Modal
      title="Create project"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim() || busy} onClick={() => void submit()} data-testid="create-project-submit">
            Create
          </button>
        </>
      }
    >
      <div className="field">
        <label>Project name</label>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Greenhouse monitor" data-testid="project-name" onKeyDown={(e) => e.key === 'Enter' && name.trim() && void submit()} />
      </div>
      <div className="field">
        <label>Board</label>
        <BoardSelect value={boardId} onChange={setBoardId} />
        <span className="faint">
          {board.logicVoltage} V logic · {board.wifi ? 'Wi-Fi · ' : ''}
          {board.simulation.mcuEmulator ? 'firmware simulation supported' : 'circuit-level simulation only'}
        </span>
      </div>
      <div className="field">
        <label>Language</label>
        <div className="row">
          {board.languages.map((l) => (
            <label key={l} className="check">
              <input type="radio" checked={language === l} onChange={() => setLanguage(l)} /> {LANGUAGE_LABELS[l]}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Template</label>
        <div className="col" style={{ gap: 4 }}>
          {available.map((t) => (
            <label key={t.id} className="check" style={{ color: 'var(--text)' }}>
              <input type="radio" checked={template === t.id} onChange={() => setTemplate(t.id)} />
              <b>{t.name}</b> <span className="muted">— {t.description}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Location</label>
        <div className="row">
          <span className="mono ellipsis grow muted">{parentDir ?? settings?.workspaceDir}</span>
          {info?.canPickDirectories && (
            <button className="btn sm" onClick={() => void call('app.pickDirectory', { title: 'Choose parent folder' }).then((d) => d && setParentDir(d))}>
              Change…
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function OpenProjectDialog() {
  const close = () => useUi.getState().setDialog(null);
  const { list, open } = useProject();
  const [path, setPath] = useState('');
  return (
    <Modal
      title="Open project"
      icon={<FolderOpen size={15} />}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!path.trim()} onClick={() => void open(path.trim()).then((ok) => ok && close())}>
            Open
          </button>
        </>
      }
    >
      <div className="field">
        <label>Project folder path</label>
        <input className="input mono" autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/project" />
        <span className="faint">The browser host cannot show a native folder picker; paste the folder path.</span>
      </div>
      {list.length > 0 && (
        <div className="field">
          <label>Known projects</label>
          <div className="card" style={{ maxHeight: 220, overflow: 'auto' }}>
            {list.map((p) => (
              <div key={p.root} className="list-row click" onClick={() => setPath(p.root)} onDoubleClick={() => void open(p.root).then((ok) => ok && close())}>
                <span className="grow ellipsis">{p.name}</span>
                <span className="faint mono ellipsis" style={{ maxWidth: 260 }}>
                  {p.root}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

function AiBuilderDialog({ idea: initialIdea }: { idea: string }) {
  const close = () => useUi.getState().setDialog(null);
  const status = useAi((s) => s.status);
  const [idea, setIdea] = useState(initialIdea);
  const [boardId, setBoardId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ProjectPlanPreview | null>(null);
  const [file, setFile] = useState('src/main.cpp');
  const generate = async () => {
    setBusy(true);
    setError(null);
    setPlan(null);
    try {
      const p = await call('ai.planProject', { idea, ...(boardId ? { boardId } : {}) });
      setPlan(p);
      setFile(Object.keys(p.files).find((f) => f.startsWith('src/main')) ?? Object.keys(p.files)[0]!);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const snap = await call('ai.createProjectFromPlan', { planId: plan.planId });
      useProject.getState().setSnapshot(snap);
      void useProject.getState().refreshList();
      useUi.getState().openTab({ id: 'simulator', kind: 'simulator', title: 'Simulator' });
      useUi.getState().toast('success', `Created ${snap.manifest.name}`);
      close();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const errs = useMemo(() => plan?.diagnostics.filter((d) => d.severity !== 'info') ?? [], [plan]);
  return (
    <Modal
      wide
      title="Build a project with AI"
      icon={<Sparkles size={15} />}
      onClose={close}
      footer={
        <>
          <span className="faint grow">Nothing is created until you click Create project. Hardware is validated deterministically.</span>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          {!plan ? (
            <button className="btn primary" disabled={busy || idea.trim().length < 3 || !status?.configured} onClick={() => void generate()}>
              <Bot size={13} /> {busy ? 'Designing…' : 'Generate plan'}
            </button>
          ) : (
            <>
              <button className="btn" disabled={busy} onClick={() => void generate()}>
                Regenerate
              </button>
              <button className="btn primary" disabled={busy} onClick={() => void create()}>
                Create project
              </button>
            </>
          )}
        </>
      }
    >
      {!status?.configured && (
        <div className="editor-banner" style={{ borderRadius: 5 }}>
          {status?.message ?? 'AI provider not configured.'}
          <span className="spacer" />
          <button
            className="btn sm"
            onClick={() => {
              close();
              useUi.getState().openTab({ id: 'settings', kind: 'settings', title: 'Settings' });
            }}
          >
            Open Settings
          </button>
        </div>
      )}
      <div className="field">
        <label>Describe your IoT idea</label>
        <textarea className="textarea" rows={3} value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="A smart plant monitor with soil moisture, temperature/humidity, an OLED display and automatic watering" />
      </div>
      <div className="field">
        <label>Board</label>
        <select className="select" value={boardId} onChange={(e) => setBoardId(e.target.value)}>
          <option value="">Let the AI choose</option>
          {getRegistry()
            .listBoards()
            .map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
        </select>
      </div>
      {error && <div className="sev-error selectable">{error}</div>}
      {plan && (
        <div className="col" style={{ gap: 10 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{plan.name}</div>
            <div className="muted">{plan.summary}</div>
            <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
              <span className="badge accent">{getRegistry().getBoard(plan.boardId)?.name ?? plan.boardId}</span>
              <span className="badge">{LANGUAGE_LABELS[plan.language]}</span>
              <span className="badge">{plan.components.length} parts</span>
              <span className="badge">{plan.attempts} model call(s)</span>
              {plan.problems.length === 0 ? <span className="badge ok">validation passed</span> : <span className="badge err">{plan.problems.length} unresolved problem(s)</span>}
            </div>
          </div>
          {plan.problems.length > 0 && (
            <div className="card selectable" style={{ padding: 8 }}>
              <b className="sev-error">Unresolved after automatic repair:</b>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {plan.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
            <div className="col" style={{ width: 300, flex: 'none' }}>
              <div className="section-title" style={{ padding: 0 }}>
                Components
              </div>
              {plan.components.map((c) => (
                <div key={c.id} style={{ fontSize: 12 }}>
                  <b>{c.id}</b> <span className="muted">{getRegistry().getComponent(c.type)?.name ?? c.type}</span>
                  {c.reason && <div className="faint">{c.reason}</div>}
                </div>
              ))}
              {errs.length > 0 && (
                <>
                  <div className="section-title" style={{ padding: 0 }}>
                    Validation
                  </div>
                  {errs.map((d, i) => (
                    <div key={i} className="row" style={{ alignItems: 'flex-start', fontSize: 12 }}>
                      <SeverityIcon severity={d.severity} /> <span>{d.message}</span>
                    </div>
                  ))}
                </>
              )}
              {plan.assumptions.length > 0 && (
                <>
                  <div className="section-title" style={{ padding: 0 }}>
                    Assumptions
                  </div>
                  {plan.assumptions.map((a) => (
                    <div key={a} className="faint" style={{ fontSize: 12 }}>
                      • {a}
                    </div>
                  ))}
                </>
              )}
            </div>
            <div className="grow col" style={{ minWidth: 0 }}>
              <select className="select" value={file} onChange={(e) => setFile(e.target.value)}>
                {Object.keys(plan.files).map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
              <pre className="card selectable" style={{ margin: 0, padding: 10, maxHeight: 340, overflow: 'auto' }}>
                {plan.files[file]}
              </pre>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function PromptDialog({ title, label, initial, onSubmit }: { title: string; label: string; initial: string; onSubmit: (v: string) => void }) {
  const close = () => useUi.getState().setDialog(null);
  const [v, setV] = useState(initial);
  const submit = () => {
    if (!v.trim()) return;
    close();
    onSubmit(v.trim());
  };
  return (
    <Modal
      title={title}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!v.trim()} onClick={submit}>
            OK
          </button>
        </>
      }
    >
      <div className="field">
        <label>{label}</label>
        <input className="input" autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
    </Modal>
  );
}

export function Dialogs() {
  const dialog = useUi((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'new-project':
      return <NewProjectDialog {...(dialog.template ? { template: dialog.template } : {})} {...(dialog.boardId ? { boardId: dialog.boardId } : {})} />;
    case 'open-project':
      return <OpenProjectDialog />;
    case 'ai-builder':
      return <AiBuilderDialog idea={dialog.idea} />;
    case 'prompt':
      return <PromptDialog title={dialog.title} label={dialog.label} initial={dialog.initial} onSubmit={dialog.onSubmit} />;
    case 'confirm':
      return (
        <Modal
          title={dialog.title}
          onClose={() => useUi.getState().setDialog(null)}
          footer={
            <>
              <button className="btn" onClick={() => useUi.getState().setDialog(null)}>
                Cancel
              </button>
              <button
                className={`btn ${dialog.danger ? 'danger' : 'primary'}`}
                onClick={() => {
                  useUi.getState().setDialog(null);
                  dialog.onConfirm();
                }}
              >
                {dialog.confirmLabel}
              </button>
            </>
          }
        >
          <div className="selectable" style={{ whiteSpace: 'pre-wrap' }}>
            {dialog.message}
          </div>
        </Modal>
      );
  }
}
