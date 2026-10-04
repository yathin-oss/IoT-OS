import { watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { IotosError } from '../../core/errors';
import type { FileNode, SearchMatch } from '../../core/ipc/contract';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.pio', '.vscode', '__pycache__']);
const IGNORED_PATHS = ['.iotos/build'];
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_TREE_ENTRIES = 5000;

/**
 * Filesystem access scoped to one project root. All paths are project-relative;
 * absolute paths, ".." escapes and symlinks pointing outside the root are rejected.
 */
export class ProjectFs {
  private watcher: FSWatcher | null = null;
  private recentWrites = new Map<string, number>();

  private constructor(readonly root: string) {}

  static async open(root: string): Promise<ProjectFs> {
    const real = await realpath(root).catch(() => {
      throw new IotosError('PROJECT_NOT_FOUND', `Folder not found: ${root}`);
    });
    return new ProjectFs(real);
  }

  /** Resolve a project-relative path to an absolute path inside the root. */
  resolve(rel: string): string {
    if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) throw new IotosError('INVALID_ARGUMENT', 'Invalid path');
    if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new IotosError('FS_PATH_OUTSIDE_PROJECT', `Absolute paths are not allowed: ${rel}`);
    const abs = normalize(join(this.root, rel));
    const r = relative(this.root, abs);
    if (r === '' || r.startsWith('..') || isAbsolute(r)) throw new IotosError('FS_PATH_OUTSIDE_PROJECT', `Path escapes the project: ${rel}`);
    return abs;
  }

  /** Verifies that the nearest existing ancestor (after symlink resolution) is inside the root. */
  private async assertInside(abs: string): Promise<void> {
    let cur = abs;
    for (;;) {
      try {
        const real = await realpath(cur);
        const r = relative(this.root, real);
        if (r.startsWith('..') || isAbsolute(r)) throw new IotosError('FS_PATH_OUTSIDE_PROJECT', 'Path resolves outside the project (symlink)');
        return;
      } catch (err) {
        if (err instanceof IotosError) throw err;
        const parent = dirname(cur);
        if (parent === cur) return;
        cur = parent;
      }
    }
  }

  toRel(abs: string): string {
    return relative(this.root, abs).split(sep).join('/');
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await stat(this.resolve(rel));
      return true;
    } catch (err) {
      if (err instanceof IotosError) throw err;
      return false;
    }
  }

  async read(rel: string): Promise<{ content: string; mtimeMs: number }> {
    const abs = this.resolve(rel);
    await this.assertInside(abs);
    try {
      const st = await stat(abs);
      if (!st.isFile()) throw new IotosError('INVALID_ARGUMENT', `${rel} is not a file`);
      if (st.size > MAX_READ_BYTES) throw new IotosError('FS_IO', `${rel} is too large to open (${Math.round(st.size / 1024 / 1024)} MB)`);
      return { content: await readFile(abs, 'utf8'), mtimeMs: st.mtimeMs };
    } catch (err) {
      if (err instanceof IotosError) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new IotosError('FS_NOT_FOUND', `File not found: ${rel}`);
      throw new IotosError('FS_IO', `Cannot read ${rel}: ${(err as Error).message}`);
    }
  }

  async readOrNull(rel: string): Promise<string | null> {
    try {
      return (await this.read(rel)).content;
    } catch (err) {
      if (err instanceof IotosError && err.code === 'FS_NOT_FOUND') return null;
      throw err;
    }
  }

  /**
   * Atomic write (temp file + rename). When expectedMtimeMs is given and the file
   * changed on disk since, the write is refused so external edits are not lost.
   */
  async write(rel: string, content: string, expectedMtimeMs?: number): Promise<{ mtimeMs: number }> {
    const abs = this.resolve(rel);
    await this.assertInside(abs);
    if (expectedMtimeMs !== undefined) {
      const st = await stat(abs).catch(() => null);
      if (st && Math.abs(st.mtimeMs - expectedMtimeMs) > 1) {
        throw new IotosError('FS_EXISTS', `${rel} was modified outside the editor`, { hint: 'Reload the file or overwrite it explicitly.', details: { path: rel, mtimeMs: st.mtimeMs } });
      }
    }
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.iotos-tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(tmp, content, 'utf8');
      await rename(tmp, abs);
    } catch (err) {
      await rm(tmp, { force: true });
      throw new IotosError('FS_IO', `Cannot write ${rel}: ${(err as Error).message}`);
    }
    this.recentWrites.set(rel, Date.now());
    return { mtimeMs: (await stat(abs)).mtimeMs };
  }

  async create(rel: string, kind: 'file' | 'dir', content = ''): Promise<void> {
    const abs = this.resolve(rel);
    await this.assertInside(abs);
    if (await this.exists(rel)) throw new IotosError('FS_EXISTS', `${rel} already exists`);
    if (kind === 'dir') await mkdir(abs, { recursive: true });
    else await this.write(rel, content);
  }

  async rename(from: string, to: string): Promise<void> {
    const a = this.resolve(from);
    const b = this.resolve(to);
    await this.assertInside(a);
    await this.assertInside(b);
    if (from.startsWith('.iotos/') || to.startsWith('.iotos/')) throw new IotosError('INVALID_ARGUMENT', 'Project model files cannot be renamed');
    if (await this.exists(to)) throw new IotosError('FS_EXISTS', `${to} already exists`);
    await mkdir(dirname(b), { recursive: true });
    await rename(a, b);
  }

  async delete(rel: string, trash?: (abs: string) => Promise<void>): Promise<void> {
    const abs = this.resolve(rel);
    await this.assertInside(abs);
    if (rel === '.iotos' || rel.startsWith('.iotos/')) throw new IotosError('INVALID_ARGUMENT', 'Project model files cannot be deleted from the editor');
    if (trash) await trash(abs);
    else await rm(abs, { recursive: true });
  }

  async tree(): Promise<FileNode[]> {
    let count = 0;
    const walk = async (dirAbs: string): Promise<FileNode[]> => {
      const entries = await readdir(dirAbs, { withFileTypes: true }).catch(() => []);
      const nodes: FileNode[] = [];
      for (const e of entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))) {
        if (++count > MAX_TREE_ENTRIES) break;
        const abs = join(dirAbs, e.name);
        const rel = this.toRel(abs);
        if (e.name.endsWith('.iotos-tmp') || e.name.includes('.iotos-tmp-')) continue;
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name) || IGNORED_PATHS.includes(rel)) continue;
          nodes.push({ name: e.name, path: rel, kind: 'dir', children: await walk(abs) });
        } else if (e.isFile() || (e.isSymbolicLink() && (await lstat(abs)).isFile())) {
          nodes.push({ name: e.name, path: rel, kind: 'file' });
        }
      }
      return nodes;
    };
    return walk(this.root);
  }

  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const visit = (nodes: FileNode[]) => {
      for (const n of nodes) n.kind === 'file' ? out.push(n.path) : visit(n.children ?? []);
    };
    visit(await this.tree());
    return out;
  }

  async search(query: string, opts: { regex?: boolean; caseSensitive?: boolean } = {}): Promise<SearchMatch[]> {
    if (!query) return [];
    let re: RegExp;
    try {
      re = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? 'g' : 'gi');
    } catch (err) {
      throw new IotosError('INVALID_ARGUMENT', `Invalid regular expression: ${(err as Error).message}`);
    }
    const out: SearchMatch[] = [];
    for (const path of await this.listFiles()) {
      if (!/\.(c|cpp|h|hpp|ino|py|md|txt|json|ini|csv|toml|yaml|yml)$/i.test(path)) continue;
      const content = await this.readOrNull(path);
      if (content === null) continue;
      content.split('\n').forEach((line, i) => {
        re.lastIndex = 0;
        const m = re.exec(line);
        if (m) out.push({ path, line: i + 1, column: m.index + 1, text: line.slice(0, 300) });
      });
      if (out.length > 2000) break;
    }
    return out;
  }

  /** Recursive watch; reports changes not caused by our own writes as external. */
  watch(onChange: (paths: string[], external: boolean) => void): void {
    this.unwatch();
    let pending = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    try {
      this.watcher = watch(this.root, { recursive: true }, (_ev, filename) => {
        if (!filename) return;
        const rel = filename.toString().split(sep).join('/');
        if (rel.startsWith('.git/') || rel.startsWith('.iotos/build') || rel.includes('.iotos-tmp')) return;
        pending.add(rel);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const paths = [...pending];
          pending = new Set();
          const now = Date.now();
          const external = paths.some((p) => now - (this.recentWrites.get(p) ?? 0) > 1500);
          onChange(paths, external);
        }, 150);
      });
      this.watcher.on('error', () => this.unwatch());
    } catch {
      // Recursive watching is unsupported on some Linux setups; changes are then picked up on reload.
      this.watcher = null;
    }
  }

  unwatch(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
