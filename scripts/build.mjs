// Builds the renderer (Vite) and the Node/Electron entry points (esbuild).
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });

await viteBuild({ configFile: 'vite.config.ts', mode: 'production' });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  // Native modules (serialport bindings) and SDKs stay in node_modules.
  packages: 'external',
  logLevel: 'info',
};

await Promise.all([
  esbuild({ ...common, entryPoints: ['src/main/electron/main.ts'], outfile: 'dist/main/main.cjs', format: 'cjs', external: ['electron'] }),
  esbuild({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.cjs', format: 'cjs', external: ['electron'] }),
  esbuild({ ...common, entryPoints: ['src/main/host/main.ts'], outfile: 'dist/host/host.mjs', format: 'esm' }),
]);
if (!watch) console.log('Build complete: dist/renderer, dist/main, dist/preload, dist/host');
