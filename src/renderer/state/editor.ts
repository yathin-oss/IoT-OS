import { create } from 'zustand';
import { ApiError, call, errorMessage } from '../api/client';
import { useProject } from './project';
import { useUi } from './ui';

export interface OpenFile {
  path: string;
  content: string;
  saved: string;
  mtimeMs: number;
  /** File changed on disk while it had unsaved edits. */
  conflict: boolean;
}

interface EditorState {
  files: Record<string, OpenFile>;
  cursor: { line: number; column: number } | null;
  open(path: string): Promise<void>;
  update(path: string, content: string): void;
  save(path: string, force?: boolean): Promise<boolean>;
  saveAll(): Promise<void>;
  reload(path: string): Promise<void>;
  onDiskChange(paths: string[]): Promise<void>;
  forget(path: string): void;
  setCursor(c: { line: number; column: number } | null): void;
  isDirty(path: string): boolean;
}

export function languageFor(path: string): string {
  if (/\.(ino|cpp|cc|cxx|c|h|hpp|hh)$/i.test(path)) return 'cpp';
  if (/\.py$/i.test(path)) return 'python';
  if (/\.json$/i.test(path)) return 'json';
  if (/\.md$/i.test(path)) return 'markdown';
  if (/\.(ini|toml|cfg)$/i.test(path)) return 'ini';
  if (/\.ya?ml$/i.test(path)) return 'yaml';
  return 'plaintext';
}

export const useEditor = create<EditorState>((set, get) => ({
  files: {},
  cursor: null,
  async open(path) {
    if (get().files[path]) return;
    try {
      const r = await call('fs.read', { path });
      set((s) => ({ files: { ...s.files, [path]: { path, content: r.content, saved: r.content, mtimeMs: r.mtimeMs, conflict: false } } }));
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
      useUi.getState().closeTab(`file:${path}`);
    }
  },
  update(path, content) {
    set((s) => {
      const f = s.files[path];
      return f ? { files: { ...s.files, [path]: { ...f, content } } } : s;
    });
  },
  async save(path, force = false) {
    const f = get().files[path];
    if (!f) return false;
    try {
      const r = await call('fs.write', { path, content: f.content, ...(force ? {} : { expectedMtimeMs: f.mtimeMs }) });
      set((s) => ({ files: { ...s.files, [path]: { ...s.files[path]!, saved: f.content, mtimeMs: r.mtimeMs, conflict: false } } }));
      void useProject.getState().refreshDiagnostics();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'FS_EXISTS') {
        set((s) => ({ files: { ...s.files, [path]: { ...s.files[path]!, conflict: true } } }));
        useUi.getState().toast('warning', `${path} changed on disk. Use "Overwrite" or "Reload" in the editor banner.`);
      } else useUi.getState().toast('error', errorMessage(err));
      return false;
    }
  },
  async saveAll() {
    for (const p of Object.keys(get().files)) if (get().isDirty(p)) await get().save(p);
  },
  async reload(path) {
    try {
      const r = await call('fs.read', { path });
      set((s) => ({ files: { ...s.files, [path]: { path, content: r.content, saved: r.content, mtimeMs: r.mtimeMs, conflict: false } } }));
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
    }
  },
  async onDiskChange(paths) {
    for (const p of paths) {
      const f = get().files[p];
      if (!f) continue;
      let r: { content: string; mtimeMs: number };
      try {
        r = await call('fs.read', { path: p });
      } catch {
        continue; // deleted or unreadable; keep buffer
      }
      if (r.content === f.saved) {
        set((s) => ({ files: { ...s.files, [p]: { ...s.files[p]!, mtimeMs: r.mtimeMs } } }));
        continue;
      }
      if (f.content === f.saved) set((s) => ({ files: { ...s.files, [p]: { path: p, content: r.content, saved: r.content, mtimeMs: r.mtimeMs, conflict: false } } }));
      else set((s) => ({ files: { ...s.files, [p]: { ...s.files[p]!, conflict: true } } }));
    }
  },
  forget(path) {
    set((s) => {
      const files = { ...s.files };
      delete files[path];
      return { files };
    });
  },
  setCursor(c) {
    set({ cursor: c });
  },
  isDirty(path) {
    const f = get().files[path];
    return !!f && f.content !== f.saved;
  },
}));
