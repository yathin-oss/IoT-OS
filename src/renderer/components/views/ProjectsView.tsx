import { Copy, FolderOpen, Pencil, Pin, PinOff, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import type { ProjectSummary } from '../../../core/ipc/contract';
import { getRegistry } from '../../../core/registry/registry';
import { call, errorMessage } from '../../api/client';
import { runCommand } from '../../commands';
import { useProject } from '../../state/project';
import { useUi } from '../../state/ui';

export function projectActions(p: ProjectSummary) {
  const ui = useUi.getState();
  const refresh = () => void useProject.getState().refreshList();
  return {
    open: () => void useProject.getState().open(p.root),
    pin: () => void call('project.setPinned', { root: p.root, pinned: !p.pinned }).then((l) => useProject.setState({ list: l })),
    rename: () =>
      ui.setDialog({
        kind: 'prompt',
        title: 'Rename project',
        label: 'Name',
        initial: p.name,
        onSubmit: (name) => void call('project.rename', { root: p.root, name }).then(refresh).catch((e: unknown) => ui.toast('error', errorMessage(e))),
      }),
    duplicate: () =>
      ui.setDialog({
        kind: 'prompt',
        title: 'Duplicate project',
        label: 'Name of the copy',
        initial: `${p.name} copy`,
        onSubmit: (name) =>
          void call('project.duplicate', { root: p.root, name })
            .then((c) => {
              ui.toast('success', `Created ${c.name}`);
              refresh();
            })
            .catch((e: unknown) => ui.toast('error', errorMessage(e))),
      }),
    remove: () =>
      ui.setDialog({
        kind: 'confirm',
        title: 'Delete project',
        message: `Move "${p.name}" (${p.root}) to the trash? It can be restored from the trash.`,
        confirmLabel: 'Move to trash',
        danger: true,
        onConfirm: () => void call('project.delete', { root: p.root }).then(refresh).catch((e: unknown) => ui.toast('error', errorMessage(e))),
      }),
  };
}

export function ProjectsView() {
  const { list, refreshList, snapshot } = useProject();
  useEffect(() => {
    void refreshList();
  }, [refreshList]);
  return (
    <>
      <div className="sidebar-head">
        <span className="grow">Projects</span>
        <button className="icon-btn" title="Build with AI" onClick={() => runCommand('project.ai')}>
          <Sparkles size={14} />
        </button>
        <button className="icon-btn" title="New project" onClick={() => runCommand('project.new')}>
          <Plus size={15} />
        </button>
        <button className="icon-btn" title="Open project folder" onClick={() => runCommand('project.open')}>
          <FolderOpen size={14} />
        </button>
      </div>
      <div className="sidebar-body">
        {list.length === 0 && <div className="empty">No projects yet.</div>}
        {list.map((p) => {
          const a = projectActions(p);
          return (
            <div key={p.root} className={`list-row click${snapshot?.root === p.root ? ' active' : ''}`} onDoubleClick={a.open} onClick={a.open} title={p.root} style={{ alignItems: 'flex-start' }}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 5 }}>
                  {p.pinned && <Pin size={11} className="muted" />}
                  <span className="ellipsis" style={{ fontWeight: 500 }}>
                    {p.name}
                  </span>
                  {p.status === 'error' && <span className="badge err">error</span>}
                </div>
                <div className="faint ellipsis" style={{ fontSize: 11.5 }}>
                  {p.status === 'error' ? p.error : `${getRegistry().getBoard(p.boardId ?? '')?.name ?? p.boardId} · ${p.componentCount} parts`}
                </div>
              </div>
              <div className="row" style={{ gap: 0 }} onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" title={p.pinned ? 'Unpin' : 'Pin'} onClick={a.pin}>
                  {p.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                </button>
                <button className="icon-btn" title="Rename" onClick={a.rename} disabled={p.status === 'error'}>
                  <Pencil size={12} />
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
    </>
  );
}
