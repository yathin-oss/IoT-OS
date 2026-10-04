import { create } from 'zustand';
import { createHistory, pushHistory, redo, replacePresent, undo, type History } from '../../core/circuit/history';
import type { Circuit, HardwareModel } from '../../core/project/schema';
import { call, errorMessage } from '../api/client';
import { useProject } from './project';
import { useUi } from './ui';

/**
 * Editable circuit model for the simulator canvas. The canvas is a view over
 * this state; every edit is a pure core operation recorded in undo history.
 */
interface CircuitState {
  history: History<Circuit> | null;
  hardware: HardwareModel | null;
  /** Saved revision for dirty tracking. */
  savedCircuit: Circuit | null;
  savedHardware: HardwareModel | null;
  selection: string[];
  /** Load from the project snapshot (keeps local edits unless forced). */
  sync(force?: boolean): void;
  apply(fn: (c: Circuit) => Circuit, opts?: { transient?: boolean }): void;
  commitTransient(base: Circuit): void;
  setHardware(h: HardwareModel): void;
  undo(): void;
  redo(): void;
  select(ids: string[]): void;
  save(): Promise<boolean>;
  revert(): void;
  dirty(): boolean;
}

export const useCircuit = create<CircuitState>((set, get) => ({
  history: null,
  hardware: null,
  savedCircuit: null,
  savedHardware: null,
  selection: [],
  sync(force = false) {
    const snap = useProject.getState().snapshot;
    if (!snap) {
      set({ history: null, hardware: null, savedCircuit: null, savedHardware: null, selection: [] });
      return;
    }
    const s = get();
    if (!force && s.history) {
      // Snapshots arrive deserialized (new objects), so compare by content.
      const unchanged = JSON.stringify(snap.circuit) === JSON.stringify(s.savedCircuit) && JSON.stringify(snap.hardware) === JSON.stringify(s.savedHardware);
      if (unchanged) return;
      if (s.dirty()) {
        // External change while editing: keep local edits; the user can save over it or revert.
        useUi.getState().toast('warning', 'The circuit changed on disk while you have unsaved edits. Save to overwrite or Revert to load it.');
        set({ savedCircuit: snap.circuit, savedHardware: snap.hardware });
        return;
      }
    }
    set({
      history: createHistory(snap.circuit),
      hardware: snap.hardware,
      savedCircuit: snap.circuit,
      savedHardware: snap.hardware,
      selection: s.selection.filter((id) => id === 'board' || snap.circuit.components.some((c) => c.id === id)),
    });
  },
  apply(fn, opts = {}) {
    const h = get().history;
    if (!h) return;
    let next: Circuit;
    try {
      next = fn(h.present);
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
      return;
    }
    if (next === h.present) return;
    set({ history: opts.transient ? replacePresent(h, next) : pushHistory(h, next) });
  },
  commitTransient(base) {
    const h = get().history;
    if (!h || h.present === base) return;
    set({ history: pushHistory(replacePresent(h, base), h.present) });
  },
  setHardware(hw) {
    set({ hardware: hw });
  },
  undo() {
    const h = get().history;
    if (h) set({ history: undo(h) });
  },
  redo() {
    const h = get().history;
    if (h) set({ history: redo(h) });
  },
  select(ids) {
    set({ selection: ids });
  },
  async save() {
    const { history, hardware } = get();
    if (!history || !hardware) return false;
    try {
      const snap = await call('project.saveModel', { circuit: history.present, hardware });
      // Keep undo history; the saved objects become the new baseline.
      set({ history: replacePresent(get().history!, snap.circuit), hardware: snap.hardware, savedCircuit: snap.circuit, savedHardware: snap.hardware });
      useProject.getState().setSnapshot(snap);
      return true;
    } catch (err) {
      useUi.getState().toast('error', errorMessage(err));
      return false;
    }
  },
  revert() {
    get().sync(true);
  },
  dirty() {
    const s = get();
    return !!s.history && (s.history.present !== s.savedCircuit || s.hardware !== s.savedHardware);
  },
}));
