# Troubleshooting

Start with **Home → Environment setup check** (or the command palette: *Environment Setup Check*). It lists every missing tool, board package, driver and permission with the exact fix.

| Symptom | Cause / fix |
|---|---|
| Build fails at *Select toolchain*: "Arduino CLI was not found" | Install arduino-cli (see TOOLCHAINS.md) or set its path in Settings → Toolchains. GUI apps on macOS do not inherit your shell `PATH`; IoT-OS also searches `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`. |
| "Board package esp32:esp32 is not installed" | Devices → Toolchains → Install, or `arduino-cli core install esp32:esp32 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json` |
| "Missing libraries: …" | Libraries view → Project dependencies → Install. Missing-header compiler errors include the library name. |
| Board not listed in Devices | Use a data-capable USB cable. Check the Drivers view: a USB-serial chip with no port means the driver is missing (or a macOS system extension needs approval in System Settings → Privacy & Security). |
| `PORT_BUSY` | Another program (Arduino IDE, `screen`, PlatformIO monitor) holds the port. Devices → Diagnose lists the process (macOS/Linux). The IoT-OS Serial Monitor is paused automatically during upload. |
| Upload: `NO_SYNC` on ESP32 | Hold BOOT, tap EN/RST, release BOOT, retry. |
| Upload: `NO_SYNC` on Nano clones | Set `toolchain.boardOptions` to `{ "cpu": "atmega328old" }` in project.json. |
| Linux: permission denied on `/dev/ttyUSB0` | `sudo usermod -aG dialout $USER`, log out and in. |
| Serial shows garbage | Baud rate mismatch — match `Serial.begin(…)`. |
| Simulator says "No firmware build yet" | Build the project first (Uno/Nano only run firmware; other boards are circuit-only). |
| Copilot: "No API key" | Settings → AI, or set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`. |
| Copilot: provider 404 | The configured model name is not available to your account — change it in Settings → AI. |
| Proposal: "changed after the proposal was created" | The file was edited after the AI answered; ask again. |
| Electron does not start: "Electron failed to install correctly" | `npx install-electron` (needs access to GitHub release downloads). Meanwhile use `npm run host`. |
| Diagnostics for a bug report | Settings → About → *Export diagnostics bundle* (secrets are redacted). Logs: `<data dir>/logs/iotos.log`. |

## Known limitations

- **Not verified on physical hardware.** No board was connected and the Arduino toolchain could not be installed in the development environment (network restricted to the npm registry). Build/upload/library flows are implemented against arduino-cli's documented CLI/JSON and tested with a test double; run `npm run test:hw` with your board to verify.
- **Electron shell not launched during development** (binary download blocked). The same UI and services were tested end to end through the browser host. Electron-specific code (preload bridge, safeStorage, dialogs, trash, CSP for `file://`) is untested.
- Only macOS was available for testing; Linux (sysfs) and Windows (PnP) USB adapters are implemented but untested.
- Firmware simulation only for ATmega328P (Uno, Nano). DHT, HC-SR04 and I2C/SPI devices are not emulated.
- MicroPython firmware installation (esptool / UF2) is documented but not automated; deploying `.py` files and mip packages is automated.
- No language server: Monaco provides syntax highlighting, find/replace and IoT-OS diagnostics, not C++/Python IntelliSense.
- No PlatformIO or PyPI providers yet; no Git UI beyond `git init` on project creation.
- The circuit solver is logic-level, not analog (no currents, no transient behaviour).
