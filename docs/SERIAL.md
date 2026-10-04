# Serial monitor & plotter

## Monitor

- Port and baud selection (300 – 921600), connect/disconnect, auto-reconnect after unplug/replug.
- Data is decoded in the main process (streaming UTF-8, CR/LF/CRLF, 4 KB line cap) and sent to the UI in **50 ms batches**. If the UI falls behind more than 5 000 lines, the oldest pending lines are dropped from the live view with a visible marker; the main-process history (20 000 lines by default) keeps everything for export and AI context.
- The UI renders only visible rows (virtualized), so 20 000+ lines stay responsive.
- Timestamps (ms), auto-scroll, pause (view only — data keeps recording), clear, text or regex filter, ANSI colours (SGR subset), export to a `.log` file, command input with history and line ending (none/LF/CR/CRLF).
- **Debug with AI** sends the recent output plus deterministic runtime signatures (ESP32 brownout, panic, watchdog, reset reason, stack overflow, MicroPython traceback with file/line, common sensor-failure messages) to the copilot.

## Telemetry format (plotter)

Each line is parsed independently (`core/serial/telemetry.ts`):

1. **Labelled pairs** (recommended, Arduino IDE 2 compatible): `temp:25.4 hum:61.2` or `temp=25.4,hum=61.2`
2. **Positional numbers** separated by comma, tab, semicolon or spaces: `25.4,61.2,723` → series `value1…valueN`
3. **Header line** of identifiers separated by comma/tab/semicolon (`temperature,humidity,soil`) names the following positional rows.

Lines without numbers (log messages) are ignored. The plotter keeps 2 000 samples, shows a selectable window (100–2 000), auto or fixed scale, per-series toggles, pause and clear.
