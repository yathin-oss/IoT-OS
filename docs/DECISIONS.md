# Decision log

Each entry: decision · alternatives · reason · trade-offs · impact.

## D1 — Desktop runtime: Electron
- **Alternatives:** Tauri (Rust), Neutralinojs, pure web app (Web Serial).
- **Reason:** Node ecosystem has mature serial (`serialport`), process control and the official AI SDKs; the dev machine had Node but no Rust toolchain; Web Serial alone cannot run compilers or flashers.
- **Trade-offs:** larger binary and memory footprint than Tauri.
- **Impact:** all hardware/toolchain access lives in Node services; the renderer is sandboxed.

## D2 — One typed API contract, two transports
- **Alternatives:** Electron-only IPC.
- **Reason:** The same services run in Electron (IPC) and in a token-protected localhost host (HTTP + SSE). This made full UI E2E testing possible without the Electron binary and lets the IDE run in a browser when Electron is unavailable.
- **Trade-offs:** the host must be secured (localhost bind, token, Host/Origin checks).
- **Impact:** `core/ipc/contract.ts` is the single source of truth; `api.ts` validates every argument with zod.

## D3 — Circuit is the source of truth for wiring
- **Alternatives:** separate pin map in hardware.json; free-form pin numbers in firmware.
- **Reason:** storing connectivity twice drifts. Pin map, BOM and firmware symbols are derived; firmware includes a generated `config.h`/`config.py`; drift is detected.
- **Impact:** moving a wire in the simulator produces a sync diagnostic and a one-click proposal to regenerate the config.

## D4 — Deterministic validation independent of AI
- **Reason:** LLM output is not trusted for electrical correctness. AI proposals pass through the same engine as manual edits; validation failures are fed back to the model (bounded repair loop) and shown to the user.
- **Gating policy:** BLOCKING stops build; ERROR stops upload unless the user explicitly confirms (physical wiring may differ from the model); WARNING/INFO never block.

## D5 — Simulator: hybrid (AVR8js MCU emulation + logic-level circuit solver)
- **Alternatives:** Wokwi API (proprietary/cloud), QEMU for ESP32 (heavy, partial peripherals), SPICE (overkill, no firmware), mock-only animation (rejected: not a real simulation).
- **Reason:** AVR8js (MIT) executes the real compiled `.hex` cycle-accurately in JS, including timers, PWM, ADC and USART, in a Web Worker. A logic-level solver over the circuit graph gives every board meaningful circuit behaviour (drivers, pull-ups, buttons, resistors, LEDs, analog sources, shorts).
- **Trade-offs:** firmware emulation only for ATmega328P boards; ESP32/RP2040/RA4M1 are circuit-only (manual pin driving). Protocol devices (DHT, I2C/SPI displays, HC-SR04 timing) are not emulated and are labelled so.
- **Impact:** capability matrix in the UI; `McuRuntime` interface for future backends.

## D6 — Toolchain: Arduino CLI as the primary C++ build/upload engine
- **Alternatives:** PlatformIO, direct gcc/esptool/avrdude orchestration.
- **Reason:** official, scriptable, JSON output, manages board packages and libraries, covers AVR/ESP32/RP2040/Renesas through cores and runs the correct uploader per board.
- **Trade-offs:** sketch layout constraints → IoT-OS stages `src/`+`include/` into a generated sketch and maps compiler paths back.
- **Impact:** esptool/avrdude/mpremote are detected separately; MicroPython deployment uses mpremote.

## D7 — AI: provider-neutral core, official SDK adapters
- **Reason:** the core defines `AIProvider`; Anthropic, OpenAI and Gemini adapters use their official SDKs; keys stay in the main process. Default: Anthropic `claude-opus-5-5` (configurable). Claude requests enable server-side refusal fallbacks and send no sampling parameters (not accepted by current Claude models).
- **Structured output:** JSON responses validated with zod; every structured task has a deterministic check and a bounded repair loop.
- **No tool use / no command execution by the AI** — results are text or proposals.

## D8 — Change proposals for every AI/generator write
- **Reason:** never overwrite user work silently. Line diffs split into blocks; partial acceptance rebuilds files exactly; base-hash conflict detection; project model files re-validated after partial selection.

## D9 — No database
- Local, file-oriented state: project files, `settings.json`, `workspace.json` (recent/pinned), secret store, logs.

## D10 — Driver installation is guidance-only
- **Reason:** silent/privileged driver installation is risky and on macOS requires user approval of system extensions anyway. IoT-OS identifies the chip, determines whether a serial port was created, explains the OS-specific situation and links to the vendor's signed driver after explicit confirmation.

## D11 — Secrets
- Electron `safeStorage` (OS keychain) when available; otherwise a 0600 file in the user data directory. Environment variables override. Keys never reach the renderer, logs, diagnostics exports or child processes.
