import { create } from 'zustand';
import type { Diagnostic } from '../../core/diagnostics';
import type { ProjectSnapshot, ProjectSummary } from '../../core/ipc/contract';
import type { Language } from '../../core/registry/types';
import { call, errorMessage } from '../api/client';
import { useUi } from './ui';

interface ProjectState {
  snapshot: ProjectSnapshot | null;
  list: ProjectSummary[];
  /** Backend diagnostics (hardware validation, firmware sync, project warnings). */
  diagnostics: Diagnostic[];
  busy: boolean;
  refreshList(): Promise<void>;
  open(root: string): Promise<boolean>;
  create(input: { name: string; boardId: string; language: Language; template: string; parentDir?: string }): Promise<boolean>;
  close(): Promise<void>;
  setSnapshot(s: ProjectSnapshot | null): void;
  refreshDiagnostics(): Promise<void>;
  refreshTree(): Promise<void>;
}

let diagTimer: ReturnType<typeof setTimeout> | null = null;

export const useProject = create<ProjectState>((set, get) => ({
  snapshot: null,
  list: [],
  diagnostics: [],
  busy: false,
  async refreshList() {
    try {
      set({ list: await call('project.list') });
    } catch (err) {
      useUi.getState().toast('error', `Could not list projects: ${errorMessage(err)}`);
    }
  },
  async open(root) {
    set({ busy: true });
    try {
      const snap = await call('project.open', { root });
      get().setSnapshot(snap);
      useUi.getState().setActivity('explorer');
      void get().refreshList();
      return true;
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
      return false;
    } finally {
      set({ busy: false });
    }
  },
  async create(input) {
    set({ busy: true });
    try {
      const snap = await call('project.create', input);
      get().setSnapshot(snap);
      useUi.getState().openTab({ id: `file:${snap.manifest.firmware.entry}`, kind: 'file', title: snap.manifest.firmware.entry.split('/').pop()!, path: snap.manifest.firmware.entry });
      useUi.getState().toast('success', `Created ${snap.manifest.name}`);
      void get().refreshList();
      return true;
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
      return false;
    } finally {
      set({ busy: false });
    }
  },
  async close() {
    await call('project.close');
    set({ snapshot: null, diagnostics: [] });
  },
  setSnapshot(s) {
    const prev = get().snapshot;
    set({ snapshot: s });
    if (!s) {
      set({ diagnostics: [] });
      return;
    }
    if (prev?.root !== s.root) {
      // Different project: reset editor tabs except home.
      const ui = useUi.getState();
      for (const t of ui.tabs) if (t.kind === 'file' || t.kind === 'proposal') ui.closeTab(t.id);
    }
    if (diagTimer) clearTimeout(diagTimer);
    diagTimer = setTimeout(() => void get().refreshDiagnostics(), 150);
  },
  async refreshDiagnostics() {
    if (!get().snapshot) return;
    try {
      set({ diagnostics: await call('project.diagnostics') });
    } catch {
      /* project closed meanwhile */
    }
  },
  async refreshTree() {
    const s = get().snapshot;
    if (!s) return;
    try {
      set({ snapshot: { ...s, tree: await call('fs.tree') } });
    } catch {
      /* ignore */
    }
  },
}));
