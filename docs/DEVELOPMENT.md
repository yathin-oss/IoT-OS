# Development setup

## Requirements

- Node.js ≥ 22 (developed on Node 24, macOS 26 arm64)
- For real builds: Arduino CLI ≥ 0.35 and the board packages you need (`arduino:avr`, `esp32:esp32`, …)
- For MicroPython: Python 3 with `mpremote` (and `esptool` to flash MicroPython firmware)

## Install

```sh
npm install
```

npm 11 holds back dependency install scripts until approved. The repository's `package.json` approves exactly two (`allowScripts`): `@serialport/bindings-cpp` (selects the prebuilt native binding) and `esbuild` (installs its platform binary). Others are denied (`@google/genai` no-op, `fsevents`, `protobufjs`).

The Electron binary is downloaded on first use: `npx install-electron` (needs access to GitHub release assets).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | esbuild watch for main/preload/host, Vite HMR for the UI, launches Electron (falls back to browser mode if Electron is not installed) |
| `npm run dev:browser` | same, but the backend runs as the browser host; open the printed URL |
| `npm run build` | typecheck + production build into `dist/` |
| `npm start` | run the built Electron app |
| `npm run host` | run the built app as a browser host (`--port`, `--data-dir`, `--workspace` flags) |
| `npm run typecheck` | `tsc --noEmit` over everything (strict) |
| `npm test` / `test:unit` / `test:integration` | Vitest |
| `npm run test:e2e` | build + Playwright (uses installed Chromium) |
| `npm run test:hw` | real-board test (see TESTING.md) |

## Layout

```
src/core        pure domain logic (shared)
src/main        Node services, API router, Electron main, browser host
src/preload     Electron preload bridge
src/renderer    React UI
tests/          integration tests + fixtures (test doubles)
e2e/            Playwright tests
docs/           documentation
scripts/        build/dev scripts
```

## Data locations

| Runtime | Data directory |
|---|---|
| Electron | `app.getPath('userData')` (e.g. `~/Library/Application Support/IoT-OS`) |
| Browser host | `--data-dir`, `$IOTOS_DATA_DIR`, or `~/.iotos` |

Contents: `settings.json`, `workspace.json`, `secrets.enc.json` / `secrets.json`, `logs/iotos.log`, `trash/` (deleted projects/files when no OS trash is available), diagnostics exports.

Default projects folder: `~/Documents/IoT-OS Projects` (Electron) or `~/IoT-OS Projects`.
