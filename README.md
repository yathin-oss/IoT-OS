# IoT-OS
by-Yathin and Spandan </br>
An AI-native development environment for IoT firmware and hardware: code editor, hardware/circuit model with deterministic validation, circuit simulator with real AVR firmware emulation, toolchain/library/board-package management, device detection, flashing, serial monitor/plotter and an AI copilot that understands the whole project — in one desktop app.

> **Hardware and software are one project.** The circuit is the source of truth for wiring; firmware pin numbers are generated from it; the build, simulator, upload checks and AI all read the same model.

## What works today

| Area | Status |
|---|---|
| Project system (create / open / save / rename / duplicate / delete-to-trash / pin / recent / templates) | Implemented, tested |
| Versioned project format (`.iotos/project.json`, `hardware.json`, `circuit.json`) with migrations | Implemented, tested |
| Board registry (ESP32 DevKit V1, ESP32-S3, ESP32-C3, Uno R3, Uno R4 Minima, Nano, Pico) and 21 components | Implemented, tested |
| Deterministic hardware validation (pins, direction, ADC/PWM/bus capabilities, strapping/USB/flash pins, ADC2+Wi-Fi, voltage levels, supply ranges, shorts, I2C addresses, current budget) | Implemented, tested |
| Circuit ↔ firmware pin sync (generated `config.h` / `config.py`, drift detection) | Implemented, tested |
| Monaco editor (tabs, syntax highlighting, find/replace, diagnostics markers, save conflicts) | Implemented, E2E-tested |
| Circuit editor (add/move/rotate/duplicate/delete, wire/unwire, edit pins & props, zoom/pan, undo/redo) | Implemented |
| Simulator: ATmega328P (Uno/Nano) runs the compiled firmware (GPIO, PWM, timers, ADC, Serial); circuit-level simulation for all boards | Implemented, tested with real AVR machine code |
| Build pipeline via Arduino CLI with parsed diagnostics → Problems | Implemented; tested against a test double (Arduino CLI was not installable in the development sandbox) |
| Upload (arduino-cli upload, MicroPython deploy via mpremote) with pre-flight checks and confirmations | Implemented; tested against test doubles |
| Device detection (VID/PID, board identification, hot-plug, busy/missing states) | Implemented; tested with serialport's MockBinding and a live macOS scan |
| Driver diagnostics (CH34x / CP210x / FTDI / native USB; macOS, Linux, Windows adapters) | Implemented; macOS adapter verified live; never installs drivers itself |
| Serial monitor (batching, filters, timestamps, ANSI, export, send, auto-reconnect) and plotter | Implemented, tested with MockBinding |
| Library manager (Arduino Library Manager via arduino-cli, MicroPython mip) | Implemented; tested against a test double |
| AI: provider abstraction (Anthropic, OpenAI, Gemini via official SDKs), context engine, chat, explain, edit-as-proposal, fix build, serial debugging, AI circuit changes, AI project builder with validation/repair loop | Implemented; tested with scripted providers and a local fake API |
| Change proposals with per-hunk accept/reject and conflict detection | Implemented, tested |
| Electron shell (sandboxed renderer, typed IPC) | Implemented and built; **not launched in development** (Electron binary download was blocked) |

See [docs/](docs/) for details and the honest list of limitations in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md#known-limitations).

## Quick start

Requirements: Node.js ≥ 22. For building/flashing real boards install [Arduino CLI](https://arduino.github.io/arduino-cli/latest/installation/) (C++ projects) and `pip install mpremote esptool` (MicroPython).

```sh
npm install
npx install-electron          # downloads the Electron binary if your npm blocked install scripts
npm run build                 # typecheck + build renderer, main, preload, host
npm start                     # Electron desktop app
# or, without Electron:
npm run host                  # prints http://127.0.0.1:<port>/#token=…  — open it in a browser
```

Development with hot reload: `npm run dev` (Electron) or `npm run dev:browser`.

Then open **Environment setup check** on the Home page: it lists exactly which tools, board packages and drivers are missing and how to install them.

## Tests

```sh
npm test                 # unit + integration (Vitest)
npm run test:e2e         # builds, then drives the real UI with Playwright
IOTOS_HW_TESTS=1 IOTOS_HW_PORT=/dev/cu.usbserial-0001 IOTOS_HW_BOARD=esp32-devkit-v1 npm run test:hw   # real board
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) and [decision log](docs/DECISIONS.md)
- [Development setup](docs/DEVELOPMENT.md)
- [Project format](docs/PROJECT_FORMAT.md)
- [Hardware registry & validation](docs/HARDWARE_REGISTRY.md)
- [Simulator](docs/SIMULATOR.md)
- [Toolchains, build & flash](docs/TOOLCHAINS.md)
- [Serial monitor & telemetry format](docs/SERIAL.md)
- [AI architecture](docs/AI.md)
- [Security](docs/SECURITY.md)
- [Testing](docs/TESTING.md)
- [Troubleshooting & known limitations](docs/TROUBLESHOOTING.md)

  
