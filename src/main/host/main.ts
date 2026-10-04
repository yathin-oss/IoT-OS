import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../api';
import { createServices } from '../services';
import { startHostServer } from './server';

/**
 * `npm run host` — runs IoT-OS services in Node and serves the UI to a local
 * browser. Equivalent functionality to the Electron app except native dialogs.
 *
 *   node dist/host/host.mjs [--port 5178] [--data-dir <dir>] [--workspace <dir>]
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const staticDir = [resolve(here, '../renderer'), resolve(process.cwd(), 'dist/renderer')].find((d) => existsSync(join(d, 'index.html'))) ?? null;
  const dataDir = resolve(arg('--data-dir') ?? process.env['IOTOS_DATA_DIR'] ?? join(homedir(), '.iotos'));
  const services = createServices({
    dataDir,
    ...(arg('--workspace') ? { defaultWorkspaceDir: resolve(arg('--workspace')!) } : {}),
    runtime: { kind: 'browser-host', version: process.versions.node, electronVersion: null },
  });
  const api = createApi(services, {
    info: () => ({ version: process.env['npm_package_version'] ?? '0.1.0', runtime: 'browser-host', platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, electronVersion: null, canPickDirectories: false }),
    pickDirectory: async () => null,
    // The browser host cannot open windows on the user's behalf; the UI shows the link instead.
    openExternal: async (url) => {
      services.logger.scope('host').info('open external requested (browser host shows link)', { url });
    },
  });
  const portArg = arg('--port');
  const host = await startHostServer({ services, api, staticDir, ...(portArg ? { port: Number(portArg) } : {}), ...(process.env['IOTOS_HOST_TOKEN'] ? { token: process.env['IOTOS_HOST_TOKEN'] } : {}) });
  if (!staticDir) console.warn('UI build not found (run `npm run build` first); serving the API only.');
  console.log(`IoT-OS is running at ${host.url}`);
  console.log(`Data: ${dataDir}`);
  const shutdown = async () => {
    await host.close();
    await services.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
