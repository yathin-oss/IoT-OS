import { ChevronDown, ChevronRight, FilePlus, FileText, Folder, FolderPlus, RefreshCw, Trash2, Pencil, RefreshCcwDot } from 'lucide-react';
import { useMemo, useState } from 'react';
import { buildGraph, deriveBom, derivePinMap } from '../../../core/circuit/graph';
import type { FileNode } from '../../../core/ipc/contract';
import { getRegistry } from '../../../core/registry/registry';
import { LANGUAGE_LABELS } from '../../../core/registry/types';
import { call, errorMessage } from '../../api/client';
import { runCommand } from '../../commands';
import { useCircuit } from '../../state/circuit';
import { useEditor } from '../../state/editor';
import { useProject } from '../../state/project';
import { useUi } from '../../state/ui';

function openFile(path: string) {
  useUi.getState().openTab({ id: `file:${path}`, kind: 'file', title: path.split('/').pop()!, path });
}

function TreeNode({ node, depth, selected, onSelect }: { node: FileNode; depth: number; selected: string | null; onSelect: (p: string) => void }) {
  const [open, setOpen] = useState(depth < 1 && node.name !== '.iotos');
  const dirty = useEditor((s) => s.isDirty(node.path));
  const isDir = node.kind === 'dir';
  return (
    <>
      <div
        className={`tree-row${selected === node.path ? ' active' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => {
          onSelect(node.path);
          if (isDir) setOpen(!open);
          else openFile(node.path);
        }}
        title={node.path}
        data-testid={`tree-${node.path}`}
      >
        <span className="chev">{isDir ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}</span>
        {isDir ? <Folder size={13} className="muted" /> : <FileText size={13} className="muted" />}
        <span className="name">{node.name}</span>
        {dirty && <span style={{ marginLeft: 'auto' }}>●</span>}
      </div>
      {isDir && open && node.children?.map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />)}
    </>
  );
}

function HardwareSummary() {
  const history = useCircuit((s) => s.history);
  const hardware = useCircuit((s) => s.hardware);
  const data = useMemo(() => {
    if (!history || !hardware) return null;
    const board = getRegistry().getBoard(hardware.boardId);
    if (!board) return null;
    const graph = buildGraph(history.present, board.id);
    return { board, pinMap: derivePinMap(graph), bom: deriveBom(history.present) };
  }, [history, hardware]);
  if (!data) return null;
  return (
    <>
      <div className="section-title">
        Hardware
        <span className="spacer" />
        <button className="icon-btn" title="Sync pin configuration from circuit" onClick={() => runCommand('pins.sync')}>
          <RefreshCcwDot size={13} />
        </button>
      </div>
      <div className="kv">
        <span className="k">Board</span>
        <span>{data.board.name}</span>
        <span className="k">MCU</span>
        <span>{data.board.mcu}</span>
        <span className="k">Logic</span>
        <span>{data.board.logicVoltage} V</span>
      </div>
      {data.bom.length > 0 && (
        <div style={{ padding: '2px 12px 6px' }}>
          {data.bom.map((l) => (
            <div key={l.type} className="row" style={{ fontSize: 12 }}>
              <span className="faint">{l.quantity}×</span>
              <span className="ellipsis">{l.name}</span>
            </div>
          ))}
        </div>
      )}
      {data.pinMap.length > 0 && (
        <>
          <div className="section-title">Pin map</div>
          <div style={{ padding: '0 12px 8px' }}>
            {data.pinMap.map((b) => (
              <div key={`${b.componentId}.${b.componentPin}`} className="row mono" style={{ fontSize: 11.5, cursor: 'pointer' }} onClick={() => useUi.getState().revealComponent(b.componentId)}>
                <span className="grow ellipsis">
                  {b.componentLabel}.{b.componentPin}
                </span>
                <span className="muted">→ {b.boardPin.label}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

export function ExplorerView() {
  const snapshot = useProject((s) => s.snapshot);
  const [selected, setSelected] = useState<string | null>(null);
  const ui = useUi();
  if (!snapshot) {
    return (
      <div className="empty">
        <h4>No project open</h4>
        <p>Create a project, open an existing one, or describe an idea on the Home page.</p>
        <div className="col">
          <button className="btn primary" onClick={() => runCommand('project.new')}>
            Create project
          </button>
          <button className="btn" onClick={() => runCommand('project.open')}>
            Open project
          </button>
        </div>
      </div>
    );
  }
  const baseDir = (() => {
    if (!selected) return 'src';
    const isDir = (function find(nodes: FileNode[]): boolean | null {
      for (const n of nodes) {
        if (n.path === selected) return n.kind === 'dir';
        const r = n.children ? find(n.children) : null;
        if (r !== null) return r;
      }
      return null;
    })(snapshot.tree);
    return isDir ? selected : selected.split('/').slice(0, -1).join('/');
  })();
  const create = (kind: 'file' | 'dir') =>
    ui.setDialog({
      kind: 'prompt',
      title: kind === 'file' ? 'New file' : 'New folder',
      label: 'Path (project-relative)',
      initial: baseDir ? `${baseDir}/` : '',
      onSubmit: (p) =>
        void call('fs.create', { path: p, kind })
          .then(() => {
            void useProject.getState().refreshTree();
            if (kind === 'file') openFile(p);
          })
          .catch((err: unknown) => ui.toast('error', errorMessage(err))),
    });
  return (
    <>
      <div className="sidebar-head">
        <span className="grow ellipsis">{snapshot.manifest.name}</span>
        <button className="icon-btn" title="New file" onClick={() => create('file')}>
          <FilePlus size={14} />
        </button>
        <button className="icon-btn" title="New folder" onClick={() => create('dir')}>
          <FolderPlus size={14} />
        </button>
        <button
          className="icon-btn"
          title="Rename selected"
          disabled={!selected}
          onClick={() =>
            selected &&
            ui.setDialog({
              kind: 'prompt',
              title: 'Rename',
              label: 'New path',
              initial: selected,
              onSubmit: (to) =>
                void call('fs.rename', { from: selected, to })
                  .then(() => {
                    ui.closeTab(`file:${selected}`);
                    useEditor.getState().forget(selected);
                    setSelected(to);
                    void useProject.getState().refreshTree();
                  })
                  .catch((err: unknown) => ui.toast('error', errorMessage(err))),
            })
          }
        >
          <Pencil size={13} />
        </button>
        <button
          className="icon-btn"
          title="Delete selected (moves to trash)"
          disabled={!selected}
          onClick={() =>
            selected &&
            ui.setDialog({
              kind: 'confirm',
              title: 'Delete',
              message: `Move ${selected} to the trash?`,
              confirmLabel: 'Delete',
              danger: true,
              onConfirm: () =>
                void call('fs.delete', { path: selected })
                  .then(() => {
                    ui.closeTab(`file:${selected}`);
                    useEditor.getState().forget(selected);
                    setSelected(null);
                    void useProject.getState().refreshTree();
                  })
                  .catch((err: unknown) => ui.toast('error', errorMessage(err))),
            })
          }
        >
          <Trash2 size={13} />
        </button>
        <button className="icon-btn" title="Refresh" onClick={() => void useProject.getState().refreshTree()}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="sidebar-body">
        <div className="faint" style={{ padding: '0 12px 6px', fontSize: 11.5 }}>
          {LANGUAGE_LABELS[snapshot.manifest.language]}
        </div>
        {snapshot.tree.map((n) => (
          <TreeNode key={n.path} node={n} depth={0} selected={selected} onSelect={setSelected} />
        ))}
        <div className="divider" />
        <HardwareSummary />
      </div>
    </>
  );
}
