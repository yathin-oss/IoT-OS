# Architecture

```
┌──────────────────────────── Renderer (React, sandboxed) ────────────────────────────┐
│ Shell: title bar · activity bar · side bar · editor tabs · bottom panels · status bar │
│ Views: Explorer · Search · Projects · Simulator · Devices · Libraries · Drivers ·     │
│        Settings · Copilot · Problems · Build · Terminal · Serial · Plotter · Output   │
│ State: zustand stores per domain (ui, project, editor, circuit, devices, build,       │
│        serial, ai, app)                                                               │
│ Simulator worker: core/sim (AVR8js + circuit solver) off the UI thread                │
└───────────────▲─────────────────────────────── typed contract (core/ipc/contract.ts) ┘
                │ Electron IPC (preload bridge)  ─or─  localhost HTTP + SSE (browser host)
┌───────────────┴──────────────────── Main process / Node services ───────────────────┐
│ api.ts — single router; zod-validates every method's arguments                        │
│ ProjectService · ProjectFs · ProposalStore · SettingsService (+SecretStore)           │
│ ToolchainManager (ArduinoCli) · LibraryManager (Arduino, mip providers)               │
│ BuildPipeline · FlashPipeline (ArduinoCliUpload, MpremoteDeploy adapters)             │
│ DeviceManager (PortLister adapter) · SerialManager · DriverHub (macOS/Linux/Windows)  │
│ AiService (providers: Anthropic / OpenAI / Gemini) · SetupService · Logger · EventBus │
│ ProcessRunner — the only way to execute programs (allowlist, no shell, timeouts)      │
└───────────────▲──────────────────────────────────────────────────────────────────────┘
                │ imports (pure, no I/O)
┌───────────────┴────────────────────────── core/ (shared, pure TypeScript) ──────────┐
│ registry (boards, components, USB chips) · project schema + migrations + factory     │
│ circuit graph/ops/history/geometry/layout · validation engine + rules · pin sync     │
│ parsers (compiler, flash tools, runtime) · serial (lines, ANSI, telemetry)          │
│ proposals (diff, selection) · docs generators · templates · sim · ai (context,       │
│ schemas, prompts, tasks)                                                             │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## Layers

**`src/core`** — pure, deterministic domain logic with no Node, Electron or React imports. Runs in the main process, the renderer and the simulator worker, and is where most tests live. Everything that decides *correctness* lives here: the registry, validation, pin sync, the circuit graph, parsers and the AI task orchestration (with the provider injected).

**`src/main`** — services that touch the outside world: filesystem, processes, serial ports, USB enumeration, network AI providers. Composed in `services.ts` (`createServices`) so Electron, the browser host and tests build the same graph with different adapters. `api.ts` exposes them through one router.

**`src/preload` / `src/main/electron`** — Electron shell. The renderer has `contextIsolation`, `sandbox`, no Node integration; the preload exposes only `call(method, args)` and `onEvent`.

**`src/main/host`** — the same API over localhost HTTP/SSE for development, automated E2E tests and running without Electron.

**`src/renderer`** — React UI. Components hold no business logic: they call the API and core functions and render state.

## The unified project model

```
.iotos/project.json   metadata, language, firmware paths, dependencies, toolchain options, runtime port/baud
.iotos/hardware.json  target board, radio features used, power source
.iotos/circuit.json   component instances (type, label, props, position) + wires (endpoint ↔ endpoint)
```

Derived (never stored twice): nets, pin map (component pin → board GPIO, through series resistors), bill of materials, required libraries, firmware pin symbols. The same derivation feeds:

- **validation** (`core/validation`) → Problems, build gating, flash gating, AI context, AI repair loop
- **pin sync** (`core/sync`) → generated `include/config.h` / `src/config.py`, drift diagnostics
- **simulator** (`core/sim`) → nets and component models
- **docs** (`core/docs`) → wiring guide, hardware list, setup guide
- **AI context** (`core/ai/context`) → hardware/circuit/pin-map sections

## Data flow examples

*Build*: UI → `build.run` → BuildPipeline: validate project → validate hardware (BLOCKING stops) → check pin sync → resolve libraries (arduino-cli lib list) → select toolchain (core installed?) → stage sketch → `arduino-cli compile` (streamed via ProcessRunner → `process.output` events) → parse diagnostics (paths mapped back to the project) → artifacts → `build.finished`.

*AI circuit change*: UI → `ai.planCircuit` → context engine → provider → JSON → zod schema → registry checks → apply to circuit → hardware validation → (errors fed back to the model, bounded retries) → ProposalStore (circuit.json + regenerated config) → user reviews diff → `proposals.apply` (schema re-validated, conflict-checked) → project reload.

## Events

`EventBus` topics (see `EventMap` in `core/ipc/contract.ts`): project/fs changes, device list, serial data (batched every 50 ms) and status, build progress/finish, flash progress/finish, process start/output/exit, proposals, log entries.

## Extensibility points

| Add… | Where |
|---|---|
| Board | `core/registry/boards/*.ts` + `BUILTIN_BOARDS` |
| Component | `core/registry/components.ts` |
| Validation rule | `core/validation/rules.ts` (`RULES`) |
| Template | `core/templates/templates.ts` |
| Toolchain / tool | `main/process/tools.ts` (`TOOL_SPECS`) + an adapter in `main/toolchain` |
| Flash method | implement `FlashAdapter` in `main/flash/flashPipeline.ts`, register in `services.ts` |
| Library ecosystem | implement `LibraryProvider` in `main/libraries` |
| AI provider | implement `AIProvider` in `main/ai/providers.ts` |
| MCU emulator | implement `McuRuntime` (`core/sim/types.ts`), map in `createRuntime` |
| OS adapter | `PortLister`, `UsbEnumerator`, `SecretStore` |
