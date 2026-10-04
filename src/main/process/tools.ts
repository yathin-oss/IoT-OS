import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Allowlist of external executables IoT-OS may run. Nothing outside this list
 * can be spawned — there is no generic "run a shell command" path, for the UI
 * or for the AI.
 */
export type ToolId = 'arduino-cli' | 'esptool' | 'mpremote' | 'avrdude' | 'mpy-cross' | 'python3' | 'git' | 'system_profiler' | 'lsof' | 'powershell';

export interface ToolSpec {
  id: ToolId;
  name: string;
  purpose: string;
  executables: string[];
  /** Python module that provides the tool when no executable is found. */
  pythonModule?: string;
  docsUrl: string | null;
  install: string | null;
  platforms?: NodeJS.Platform[];
}

export const TOOL_SPECS: Record<ToolId, ToolSpec> = {
  'arduino-cli': {
    id: 'arduino-cli',
    name: 'Arduino CLI',
    purpose: 'Compiles and uploads Arduino C++ firmware; manages board packages and libraries.',
    executables: ['arduino-cli'],
    docsUrl: 'https://arduino.github.io/arduino-cli/latest/installation/',
    install: 'macOS: brew install arduino-cli · Windows: winget install ArduinoSA.CLI · Linux: curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh',
  },
  esptool: {
    id: 'esptool',
    name: 'esptool',
    purpose: 'Flashes firmware images (e.g. MicroPython) to ESP32 boards and identifies ESP chips.',
    executables: ['esptool', 'esptool.py'],
    pythonModule: 'esptool',
    docsUrl: 'https://docs.espressif.com/projects/esptool/en/latest/',
    install: 'pip install esptool',
  },
  mpremote: {
    id: 'mpremote',
    name: 'mpremote',
    purpose: 'Copies MicroPython files to boards, installs mip packages and resets devices.',
    executables: ['mpremote'],
    pythonModule: 'mpremote',
    docsUrl: 'https://docs.micropython.org/en/latest/reference/mpremote.html',
    install: 'pip install mpremote',
  },
  avrdude: {
    id: 'avrdude',
    name: 'avrdude',
    purpose: 'AVR programmer (installed automatically with the Arduino AVR board package).',
    executables: ['avrdude'],
    docsUrl: 'https://github.com/avrdudes/avrdude',
    install: 'Installed with: arduino-cli core install arduino:avr',
  },
  'mpy-cross': {
    id: 'mpy-cross',
    name: 'mpy-cross',
    purpose: 'MicroPython cross-compiler used to syntax-check .py files.',
    executables: ['mpy-cross'],
    pythonModule: 'mpy_cross',
    docsUrl: 'https://pypi.org/project/mpy-cross/',
    install: 'pip install mpy-cross',
  },
  python3: {
    id: 'python3',
    name: 'Python 3',
    purpose: 'Runs Python-based tools (esptool, mpremote).',
    executables: ['python3', 'python'],
    docsUrl: 'https://www.python.org/downloads/',
    install: 'Install Python 3 from python.org or your package manager.',
  },
  git: {
    id: 'git',
    name: 'Git',
    purpose: 'Initialises version control for new projects.',
    executables: ['git'],
    docsUrl: 'https://git-scm.com/downloads',
    install: 'Install Git from git-scm.com.',
  },
  system_profiler: {
    id: 'system_profiler',
    name: 'system_profiler',
    purpose: 'Enumerates USB devices on macOS for driver diagnostics.',
    executables: ['/usr/sbin/system_profiler'],
    docsUrl: null,
    install: null,
    platforms: ['darwin'],
  },
  lsof: {
    id: 'lsof',
    name: 'lsof',
    purpose: 'Finds which process holds a serial port (macOS/Linux).',
    executables: ['/usr/sbin/lsof', '/usr/bin/lsof', 'lsof'],
    docsUrl: null,
    install: null,
    platforms: ['darwin', 'linux'],
  },
  powershell: {
    id: 'powershell',
    name: 'PowerShell',
    purpose: 'Enumerates USB devices and driver status on Windows.',
    executables: ['powershell.exe'],
    docsUrl: null,
    install: null,
    platforms: ['win32'],
  },
};

export interface ResolvedTool {
  id: ToolId;
  exe: string;
  /** Arguments prepended before user arguments (e.g. ["-m", "esptool"]). */
  prefixArgs: string[];
  source: 'settings' | 'path' | 'known-location' | 'python-module';
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== 'win32') accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Directories searched in addition to PATH (GUI apps often start with a minimal PATH). */
export function extraSearchDirs(platform: NodeJS.Platform = process.platform, home = homedir()): string[] {
  const dirs: string[] = [];
  if (platform === 'darwin') {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin');
    const pyRoot = join(home, 'Library', 'Python');
    if (existsSync(pyRoot)) for (const v of safeReaddir(pyRoot)) dirs.push(join(pyRoot, v, 'bin'));
    dirs.push('/Library/Frameworks/Python.framework/Versions/Current/bin');
  }
  if (platform !== 'win32') dirs.push(join(home, '.local', 'bin'), join(home, 'bin'), '/usr/bin', '/bin');
  if (platform === 'win32') {
    const local = process.env['LOCALAPPDATA'];
    if (local) dirs.push(join(local, 'Programs', 'Arduino CLI'), join(local, 'Microsoft', 'WindowsApps'));
    const appData = process.env['APPDATA'];
    if (appData) for (const v of safeReaddir(join(appData, 'Python'))) dirs.push(join(appData, 'Python', v, 'Scripts'));
  }
  dirs.push(join(home, '.platformio', 'penv', 'bin'));
  return dirs;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Arduino15 data directory where board packages (and their bundled tools) live. */
export function arduinoDataDir(platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Arduino15');
  if (platform === 'win32') return join(process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'Arduino15');
  return join(home, '.arduino15');
}

/** avrdude ships inside the arduino:avr package; find the newest copy. */
function bundledAvrdude(): string[] {
  const base = join(arduinoDataDir(), 'packages', 'arduino', 'tools', 'avrdude');
  return safeReaddir(base)
    .sort()
    .reverse()
    .map((v) => join(base, v, 'bin', process.platform === 'win32' ? 'avrdude.exe' : 'avrdude'));
}

export class ToolResolver {
  private cache = new Map<ToolId, ResolvedTool | null>();

  constructor(
    private readonly override: (id: ToolId) => string | null,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  clearCache(): void {
    this.cache.clear();
  }

  private searchPath(names: string[]): string | null {
    const pathDirs = (this.env['PATH'] ?? '').split(delimiter).filter(Boolean);
    const dirs = [...pathDirs, ...extraSearchDirs()];
    // .cmd/.bat shims need a shell to run; IoT-OS never uses one, so only real executables qualify.
    const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
    for (const n of names) {
      if (n.includes('/') || n.includes('\\')) {
        if (isExecutable(n)) return n;
        continue;
      }
      for (const d of dirs) for (const e of exts) {
        const p = join(d, n + e);
        if (isExecutable(p)) return p;
      }
    }
    return null;
  }

  /** Resolve without executing anything. Python-module fallbacks are verified by the caller. */
  resolve(id: ToolId): ResolvedTool | null {
    if (this.cache.has(id)) return this.cache.get(id)!;
    const spec = TOOL_SPECS[id];
    let resolved: ResolvedTool | null = null;
    if (spec.platforms && !spec.platforms.includes(process.platform)) {
      this.cache.set(id, null);
      return null;
    }
    const configured = this.override(id);
    if (configured) {
      resolved = isExecutable(configured) ? { id, exe: configured, prefixArgs: [], source: 'settings' } : null;
      this.cache.set(id, resolved);
      return resolved;
    }
    const found = this.searchPath(spec.executables);
    if (found) resolved = { id, exe: found, prefixArgs: [], source: 'path' };
    if (!resolved && id === 'avrdude') {
      const b = bundledAvrdude().find(isExecutable);
      if (b) resolved = { id, exe: b, prefixArgs: [], source: 'known-location' };
    }
    if (!resolved && spec.pythonModule) {
      const py = this.searchPath(TOOL_SPECS.python3.executables);
      if (py) resolved = { id, exe: py, prefixArgs: ['-m', spec.pythonModule], source: 'python-module' };
    }
    this.cache.set(id, resolved);
    return resolved;
  }

  /** Forget a resolution (e.g. python-module fallback proved unusable). */
  invalidate(id: ToolId): void {
    this.cache.set(id, null);
  }
}
