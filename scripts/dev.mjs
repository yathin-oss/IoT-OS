// Development runner.
//   npm run dev            -> Electron (if its binary is installed) + Vite HMR
//   npm run dev -- --browser -> browser host (Node API) + Vite HMR at http://127.0.0.1:5173
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { context } from 'esbuild';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const browserMode = process.argv.includes('--browser');
const API_PORT = 5178;
const TOKEN = process.env.IOTOS_HOST_TOKEN ?? 'dev-token-local-only';

function electronBinary() {
  try {
    const p = require('electron');
    return typeof p === 'string' && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: true, packages: 'external', logLevel: 'warning' };
const main = await context({ ...common, entryPoints: ['src/main/electron/main.ts'], outfile: 'dist/main/main.cjs', format: 'cjs', external: ['electron'] });
const preload = await context({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.cjs', format: 'cjs', external: ['electron'] });
const host = await context({ ...common, entryPoints: ['src/main/host/main.ts'], outfile: 'dist/host/host.mjs', format: 'esm' });
await Promise.all([main.rebuild(), preload.rebuild(), host.rebuild()]);

const electron = browserMode ? null : electronBinary();
if (!browserMode && !electron) console.warn('Electron binary not installed (run `npx install-electron`); falling back to browser mode.');

const vite = await createServer({
  configFile: 'vite.config.ts',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true, headers: { origin: `http://127.0.0.1:${API_PORT}` } },
    },
  },
});
await vite.listen();

let child = null;
const start = () => {
  if (electron) {
    child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, IOTOS_DEV_SERVER_URL: 'http://localhost:5173/' } });
  } else {
    child = spawn(process.execPath, ['dist/host/host.mjs', '--port', String(API_PORT)], { stdio: 'inherit', env: { ...process.env, IOTOS_HOST_TOKEN: TOKEN } });
    console.log(`\nIoT-OS dev UI: http://127.0.0.1:5173/#token=${TOKEN}\n`);
  }
};
start();

// Restart the backend when main-process code changes.
for (const ctx of [main, preload, host]) {
  await ctx.watch();
}
let timer = null;
const { watch } = await import('node:fs');
watch('src', { recursive: true }, (_e, file) => {
  if (!file || file.startsWith('renderer')) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`[dev] ${file} changed — restarting backend`);
    child?.kill();
    setTimeout(start, 300);
  }, 400);
});
const stop = async () => {
  child?.kill();
  await vite.close();
  await Promise.all([main.dispose(), preload.dispose(), host.dispose()]);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
