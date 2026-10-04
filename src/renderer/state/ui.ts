import { create } from 'zustand';

export type ActivityId = 'explorer' | 'search' | 'projects' | 'simulator' | 'devices' | 'libraries' | 'drivers' | 'settings';
export type BottomTab = 'problems' | 'build' | 'terminal' | 'serial' | 'plotter' | 'output';
export type TabKind = 'home' | 'file' | 'simulator' | 'settings' | 'proposal' | 'setup';

export interface EditorTab {
  id: string;
  kind: TabKind;
  title: string;
  path?: string;
  proposalId?: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export type DialogState =
  | null
  | { kind: 'new-project'; template?: string; boardId?: string }
  | { kind: 'ai-builder'; idea: string }
  | { kind: 'open-project' }
  | { kind: 'prompt'; title: string; label: string; initial: string; onSubmit: (value: string) => void }
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void };

interface Layout {
  sidebarOpen: boolean;
  sidebarWidth: number;
  copilotOpen: boolean;
  copilotWidth: number;
  bottomOpen: boolean;
  bottomHeight: number;
}

const LAYOUT_KEY = 'iotos.layout.v1';
function loadLayout(): Layout {
  const def: Layout = { sidebarOpen: true, sidebarWidth: 260, copilotOpen: true, copilotWidth: 360, bottomOpen: true, bottomHeight: 230 };
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? { ...def, ...(JSON.parse(raw) as Partial<Layout>) } : def;
  } catch {
    return def;
  }
}
function saveLayout(l: Layout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
  } catch {
    /* per-viewer convenience only */
  }
}

interface UiState extends Layout {
  activity: ActivityId;
  bottomTab: BottomTab;
  tabs: EditorTab[];
  activeTabId: string;
  paletteOpen: boolean;
  toasts: Toast[];
  dialog: DialogState;
  /** Requests the editor to reveal a location. */
  reveal: { path: string; line: number; column: number; nonce: number } | null;
  /** Selection requests for the circuit canvas (e.g. from Problems). */
  focusComponent: { id: string; nonce: number } | null;
  setActivity(a: ActivityId): void;
  setLayout(patch: Partial<Layout>): void;
  showBottom(tab: BottomTab): void;
  openTab(tab: EditorTab): void;
  closeTab(id: string): void;
  setActiveTab(id: string): void;
  setPalette(open: boolean): void;
  toast(kind: Toast['kind'], message: string): void;
  dismissToast(id: number): void;
  setDialog(d: DialogState): void;
  revealLocation(path: string, line: number, column?: number): void;
  revealComponent(id: string): void;
}

const HOME: EditorTab = { id: 'home', kind: 'home', title: 'Home' };
let toastId = 0;

export const useUi = create<UiState>((set, get) => ({
  ...loadLayout(),
  activity: 'explorer',
  bottomTab: 'problems',
  tabs: [HOME],
  activeTabId: 'home',
  paletteOpen: false,
  toasts: [],
  dialog: null,
  reveal: null,
  focusComponent: null,
  setActivity(a) {
    const s = get();
    if (s.activity === a && s.sidebarOpen) s.setLayout({ sidebarOpen: false });
    else set({ activity: a, sidebarOpen: true });
    if (a === 'simulator') s.openTab({ id: 'simulator', kind: 'simulator', title: 'Simulator' });
    if (a === 'settings') s.openTab({ id: 'settings', kind: 'settings', title: 'Settings' });
  },
  setLayout(patch) {
    set(patch);
    const s = get();
    saveLayout({ sidebarOpen: s.sidebarOpen, sidebarWidth: s.sidebarWidth, copilotOpen: s.copilotOpen, copilotWidth: s.copilotWidth, bottomOpen: s.bottomOpen, bottomHeight: s.bottomHeight });
  },
  showBottom(tab) {
    set({ bottomTab: tab });
    get().setLayout({ bottomOpen: true });
  },
  openTab(tab) {
    const exists = get().tabs.some((t) => t.id === tab.id);
    set((s) => ({ tabs: exists ? s.tabs.map((t) => (t.id === tab.id ? { ...t, ...tab } : t)) : [...s.tabs, tab], activeTabId: tab.id }));
  },
  closeTab(id) {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      const next = tabs.length ? tabs : [HOME];
      const active = s.activeTabId === id ? (next[Math.max(0, Math.min(idx - 1, next.length - 1))]?.id ?? 'home') : s.activeTabId;
      return { tabs: next, activeTabId: active };
    });
  },
  setActiveTab(id) {
    set({ activeTabId: id });
  },
  setPalette(open) {
    set({ paletteOpen: open });
  },
  toast(kind, message) {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message }] }));
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 9000 : 4500);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  setDialog(d) {
    set({ dialog: d });
  },
  revealLocation(path, line, column = 1) {
    get().openTab({ id: `file:${path}`, kind: 'file', title: path.split('/').pop()!, path });
    set({ reveal: { path, line, column, nonce: Date.now() } });
  },
  revealComponent(id) {
    get().openTab({ id: 'simulator', kind: 'simulator', title: 'Simulator' });
    set({ focusComponent: { id, nonce: Date.now() } });
  },
}));
