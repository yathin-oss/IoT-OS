# Toolchains, build, flash, libraries

## Tools

All external programs run through `ProcessRunner` (see SECURITY.md). Tools are discovered from the Settings path, then `PATH`, then common locations (`/opt/homebrew/bin`, `~/Library/Python/*/bin`, `~/.local/bin`, the Arduino15 avrdude, …), and for Python tools `python3 -m <module>`.

| Tool | Used for | Minimum | Install |
|---|---|---|---|
| `arduino-cli` | compile/upload C++, board packages, Arduino libraries | 0.35 | `brew install arduino-cli` · `winget install ArduinoSA.CLI` · install script |
| `mpremote` | deploy MicroPython files, mip packages | — | `pip install mpremote` |
| `esptool` | ESP chip tools (detected; MicroPython firmware flashing is a documented manual step) | 4.0 | `pip install esptool` |
| `avrdude` | AVR programming (ships with `arduino:avr`; invoked by arduino-cli) | — | `arduino-cli core install arduino:avr` |
| `mpy-cross` | exact MicroPython syntax checking (falls back to CPython `ast`) | — | `pip install mpy-cross` |
| `python3`, `git` | Python tools; `git init` for new projects | — | |

Devices → Toolchains and the Setup check show installed / missing / invalid-version / unsupported with the fix command.

## Board packages

Per registry board: `arduino:avr` (Uno, Nano), `arduino:renesas_uno` (Uno R4), `esp32:esp32` (Boards Manager URL `https://espressif.github.io/arduino-esp32/package_esp32_index.json`), `rp2040:rp2040` (earlephilhower). **Install** runs `arduino-cli core update-index` + `core install` with the board's `--additional-urls`, streamed to the Terminal panel.

## Build pipeline

`validate-project → validate-hardware → check-sync → resolve-dependencies → select-toolchain → compile → artifact`

- C++: `src/**` and `include/**` are staged into `.iotos/build/sketch/` (a generated `sketch.ino` + `src/`), `lib/*` folders are passed with `--library`, `arduino-cli compile --fqbn <fqbn[:options]> --build-path .iotos/build/out --warnings default`. Compiler/linker output is parsed (file, line, column, severity, code, message; `-W…` flags become codes; missing headers are mapped to the library that provides them) and file paths are mapped back to project paths. The size report (`Sketch uses …`) is parsed.
- MicroPython: each `src/**/*.py` is checked with `mpy-cross` or CPython `ast.parse`; artifacts are the files to deploy.
- Results are kept in memory and `.iotos/build/last-build.json`; statuses: succeeded, failed, cancelled, blocked.

## Upload

Pre-flight checks (`FlashPipeline.preflight`): board known and flash-supported; hardware validation (BLOCKING blocks; ERROR confirmable); port connected and not busy (the IoT-OS Serial Monitor is paused automatically and reopened afterwards); USB identity consistent with the project board (otherwise confirmable); upload tool installed; a successful build exists for this board (stale sources confirmable).

Adapters: `arduino-cli upload --fqbn … --port … --input-dir …` (C++) and `mpremote connect <port> fs cp … + mip install … + reset` (MicroPython). Progress lines (esptool/avrdude) are parsed; failures are classified (`PORT_BUSY`, `PERMISSION_DENIED`, `PORT_NOT_FOUND`, `NO_SYNC`, `WRONG_CHIP`, `TIMEOUT`, `DEVICE_DISCONNECTED`, `FILE_ERROR`) with a hint.

## Libraries

Provider abstraction (`LibraryProvider`): **Arduino Library Manager** (search, install with version, uninstall, upgrade, update check via `arduino-cli outdated`, dependencies installed by arduino-cli, architecture compatibility vs the project board) and **MicroPython mip** (micropython-lib index search; install/remove on the connected board via mpremote). Dependency resolution compares declared (`project.json`), circuit-required and installed libraries (`ok`, `missing`, `version-mismatch`, `not-declared`). PlatformIO and PyPI are not implemented (the interface allows adding them).
