# Testing

| Suite | Command | What it covers |
|---|---|---|
| Unit (`src/**/*.test.ts`) | `npm run test:unit` | registry integrity; project schemas, corruption/version errors, migrations; every template validates on every supported board/language; validation rules (input-only, strapping, ADC2+Wi-Fi, logic levels, supply ranges, shorts, buses, I2C addresses, current budget, determinism); circuit graph/ops/history/geometry; pin sync (generation, drift when a wire moves, literals); compiler/linker/flash/runtime parsers; serial line assembly (UTF-8 splits, CRLF, throughput), ANSI, telemetry; diff blocks and partial application; proposals and conflicts; **AVR simulation with real machine code** (LED via resistor, button input with pull-up, PWM duty, USART output, ADC from a potentiometer), circuit-only simulation, shorts; AI context prioritization/truncation, JSON extraction, project builder repair loop, circuit planning, edit-path restrictions, debug analysis |
| Integration (`tests/integration`) | `npm run test:integration` | project lifecycle through the API router (create/list/pin/rename/duplicate/delete-to-trash, corrupted/missing/new-version files), filesystem safety (traversal, absolute paths, symlink escapes, model-file protection, external modification), API boundary (unknown methods, invalid args, URL allowlist, key secrecy, redacted diagnostics); toolchain detection, build pipeline (success, compiler errors mapped to project paths, missing header → library, missing libraries, missing core, blocked by short), simulator running the build artifact; device detection/identification/disconnect, upload (blocked without build, success, identity confirmation, disconnected port, uploader failure classification), serial streaming/batching/writing/overflow and pause-for-upload; library resolution/search/install; AI providers against a local fake HTTP API (request shape, headers, errors, refusal); AI service via the router (not configured, chat context, edit proposal + partial apply, conflict, circuit proposal with regenerated config, corrupted partial selection rejected, project creation from plan); process runner (no shell, exit codes, timeout, cancel, missing tool, secret env stripping, argument-injection guards, redaction); driver parsers (macOS both formats, Windows PnP, driver-missing correlation, lsof) |
| E2E (`e2e/`) | `npm run test:e2e` | builds the app, starts the browser host and drives the real UI in Chromium: create project → edit in Monaco → save → no problems → build → run simulator (firmware prints "Hi"; pressing the on-canvas button lights the LED) → AI chat with project context → AI code edit → review → accept → file changed; blocking wiring error shown in Problems and blocks the build |
| Hardware (`tests/integration/hardware.test.ts`) | `IOTOS_HW_TESTS=1 IOTOS_HW_PORT=<port> IOTOS_HW_BOARD=<board-id> npm run test:hw` | real arduino-cli + real board: create blink → build → upload → read `LED on/off` over serial. Skipped unless enabled. |

## Test doubles (clearly isolated)

- `tests/fixtures/fake-arduino-cli.mjs` — mimics arduino-cli 1.x commands/JSON used by IoT-OS; its "firmware" output is a hex supplied by the test (real AVR machine code assembled with avr8js's assembler).
- `tests/fixtures/fake-anthropic.mjs` — local Messages-API-compatible server for E2E.
- `@serialport/binding-mock` — serial ports in integration tests.
- Scripted `AIProvider` implementations in unit/integration tests.

None of these are used by the application at runtime.

## Results at the time of writing

- Unit + integration: **150 passed, 1 skipped** (hardware, not enabled).
- E2E: **2 passed**.
- Typecheck (strict): clean. `npm audit --omit=dev`: 0 vulnerabilities.
