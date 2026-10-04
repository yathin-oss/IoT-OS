import type { Diagnostic } from '../diagnostics';

/**
 * Deterministic detectors for well-known runtime failure signatures in serial
 * output. These are *observations*, fed to the AI as facts and shown in the
 * Problems panel; interpretation is left to the user/AI.
 */

interface Signature {
  code: string;
  re: RegExp;
  message: (m: RegExpExecArray) => string;
  hint: string;
  severity: Diagnostic['severity'];
}

const SIGNATURES: Signature[] = [
  {
    code: 'ESP_BROWNOUT',
    re: /Brownout detector was triggered/,
    message: () => 'ESP32 brownout reset: supply voltage dropped too low',
    hint: 'Power-hungry parts (servos, relays, Wi-Fi TX) can sag the supply. Use a better USB cable/port or an external supply.',
    severity: 'error',
  },
  {
    code: 'ESP_PANIC',
    re: /Guru Meditation Error: Core\s+(\d+) panic'ed \(([^)]+)\)/,
    message: (m) => `ESP32 crash on core ${m[1]}: ${m[2]}`,
    hint: 'Usually a null pointer, stack overflow or invalid memory access. Decode the backtrace to locate the faulting line.',
    severity: 'error',
  },
  {
    code: 'ESP_WDT',
    re: /(Task watchdog got triggered|Interrupt wdt timeout)/,
    message: (m) => `ESP32 watchdog: ${m[1]}`,
    hint: 'A task blocked for too long. Avoid long loops without delay()/yield().',
    severity: 'error',
  },
  {
    code: 'ESP_RESET_REASON',
    re: /rst:0x([0-9a-f]+) \(([A-Z_]+)\)/i,
    message: (m) => `ESP reset reason: ${m[2]} (0x${m[1]})`,
    hint: 'Repeated resets indicate a crash loop or power problem.',
    severity: 'info',
  },
  {
    code: 'ESP_STACK_OVERFLOW',
    re: /Stack canary watchpoint triggered \(([^)]+)\)/,
    message: (m) => `Stack overflow in task ${m[1]}`,
    hint: 'Increase the task stack size or reduce local array sizes.',
    severity: 'error',
  },
  {
    code: 'PY_TRACEBACK',
    re: /^(\w+(?:Error|Exception)): (.*)$/m,
    message: (m) => `MicroPython ${m[1]}: ${m[2]}`,
    hint: 'See the traceback lines above for the file and line.',
    severity: 'error',
  },
  {
    code: 'SENSOR_READ_FAILED',
    re: /(Failed to read from DHT sensor|Could not find a valid BME280|SSD1306 allocation failed)/i,
    message: (m) => `Sensor/driver failure reported by firmware: "${m[1]}"`,
    hint: 'Check wiring, power and I2C address for the device.',
    severity: 'warning',
  },
];

export function detectRuntimeIssues(lines: string[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const text = lines.join('\n');
  for (const sig of SIGNATURES) {
    const re = new RegExp(sig.re.source, sig.re.flags.includes('g') ? sig.re.flags : sig.re.flags + 'g');
    let count = 0;
    let first: RegExpExecArray | null = null;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      count++;
      first ??= m;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (!first) continue;
    const message = sig.message(first) + (count > 1 ? ` (×${count})` : '');
    if (seen.has(message)) continue;
    seen.add(message);
    out.push({ code: sig.code, severity: sig.severity, source: 'runtime', message, hint: sig.hint });
  }
  // MicroPython traceback locations
  const tb = /File "([^"]+)", line (\d+)/g;
  let last: RegExpExecArray | null = null;
  for (let m = tb.exec(text); m; m = tb.exec(text)) last = m;
  if (last) {
    const pyErr = out.find((d) => d.code === 'PY_TRACEBACK');
    if (pyErr) pyErr.target = { file: last[1]!.replace(/^\//, ''), line: Number(last[2]) };
  }
  return out;
}
