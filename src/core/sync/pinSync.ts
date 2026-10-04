import type { Diagnostic } from '../diagnostics';
import type { CircuitGraph, PinBinding } from '../circuit/graph';
import { getRegistry, isGpio, type HardwareRegistry } from '../registry/registry';
import type { BoardDefinition, Language } from '../registry/types';

/**
 * Firmware <-> circuit synchronisation.
 *
 * The circuit is the source of truth for pin assignments. IoT-OS generates a
 * pin configuration file (include/config.h or src/config.py) from it and detects
 * when firmware sources disagree with the circuit, e.g.
 *     circuit: LED1.A -> GPIO26      firmware: #define LED1_PIN 25
 */

export interface PinSymbol {
  name: string;
  /** Value as it should appear in source (e.g. "25", "A0"). */
  value: string;
  gpio: number;
  boardPin: string;
  comment: string;
  componentId?: string;
}

export function symbolPrefix(label: string): string {
  const s = label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[A-Z]/.test(s) ? s : `C_${s}`;
}

function pinValue(boardPin: PinBinding['boardPin'], language: Language): string {
  if (language === 'arduino-cpp' && boardPin.arduinoSymbol) return boardPin.arduinoSymbol;
  return String(boardPin.gpio);
}

/** Expected pin symbols derived from the circuit's pin map. */
export function expectedPinSymbols(graph: CircuitGraph, pinMap: PinBinding[], language: Language): PinSymbol[] {
  const out: PinSymbol[] = [];
  const names = new Set<string>();
  const push = (s: PinSymbol) => {
    let name = s.name;
    let n = 2;
    while (names.has(name)) name = `${s.name}_${n++}`;
    names.add(name);
    out.push({ ...s, name });
  };
  for (const b of pinMap) {
    const def = graph.defs.get(b.componentId);
    const sym = def?.firmware.symbols.find((s) => s.pin === b.componentPin);
    if (!sym) continue;
    push({
      name: `${symbolPrefix(b.componentLabel)}_${sym.suffix}`,
      value: pinValue(b.boardPin, language),
      gpio: b.boardPin.gpio,
      boardPin: b.boardPin.id,
      componentId: b.componentId,
      comment: `${b.componentLabel}.${b.componentPin} -> ${b.boardPin.label}${b.via ? ` (via ${graph.instances.get(b.via)?.label ?? b.via})` : ''}`,
    });
  }
  // Bus-level symbols: first device found on each bus signal.
  const busSyms: Record<string, string> = { 'i2c:sda': 'I2C_SDA', 'i2c:scl': 'I2C_SCL', 'spi:sck': 'SPI_SCK', 'spi:mosi': 'SPI_MOSI', 'spi:miso': 'SPI_MISO' };
  const doneBus = new Set<string>();
  for (const b of pinMap) {
    const pin = graph.defs.get(b.componentId)?.pins.find((p) => p.id === b.componentPin);
    if (!pin?.bus) continue;
    const key = `${pin.bus.kind}:${pin.bus.signal}`;
    const name = busSyms[key];
    if (!name || doneBus.has(key)) continue;
    doneBus.add(key);
    push({ name, value: pinValue(b.boardPin, language), gpio: b.boardPin.gpio, boardPin: b.boardPin.id, comment: `${pin.bus.kind.toUpperCase()} ${pin.bus.signal.toUpperCase()} -> ${b.boardPin.label}` });
  }
  return out;
}

export const GENERATED_MARKER = 'IoT-OS generated pin configuration';

export function generateConfigFile(language: Language, symbols: PinSymbol[], board: BoardDefinition): string {
  const width = Math.max(0, ...symbols.map((s) => s.name.length));
  if (language === 'micropython') {
    const lines = [
      `# ${GENERATED_MARKER} — regenerate instead of editing by hand.`,
      `# Source: .iotos/circuit.json  Board: ${board.name}`,
      '',
      ...symbols.map((s) => `${s.name.padEnd(width)} = ${s.value}  # ${s.comment}`),
      '',
    ];
    return lines.join('\n');
  }
  const lines = [
    `// ${GENERATED_MARKER} — regenerate instead of editing by hand.`,
    `// Source: .iotos/circuit.json  Board: ${board.name}`,
    '#pragma once',
    '',
    ...symbols.map((s) => `#define ${s.name.padEnd(width)} ${s.value.padEnd(4)} // ${s.comment}`),
    '',
  ];
  return lines.join('\n');
}

export interface SourceDefinition {
  name: string;
  value: string;
  file: string;
  line: number;
  column: number;
}

const C_DEFINE = /^\s*#\s*define\s+([A-Za-z_]\w*)\s+([^\s/]+)/;
const C_CONST = /^\s*(?:static\s+)?(?:const(?:expr)?\s+)?(?:static\s+)?(?:const\s+)?(?:int|uint8_t|int8_t|uint16_t|byte|unsigned(?:\s+int)?|gpio_num_t|pin_size_t)\s+([A-Za-z_]\w*)\s*=\s*([^;\s]+)\s*;/;
const PY_ASSIGN = /^([A-Z_][A-Z0-9_]*)\s*=\s*([^\s#]+)/;

/** Extract constant definitions that may hold pin numbers. */
export function extractDefinitions(file: string, content: string): SourceDefinition[] {
  const isPy = file.endsWith('.py');
  const out: SourceDefinition[] = [];
  content.split(/\r?\n/).forEach((text, i) => {
    const m = isPy ? PY_ASSIGN.exec(text) : (C_DEFINE.exec(text) ?? C_CONST.exec(text));
    if (m) out.push({ name: m[1]!, value: m[2]!.replace(/[()]/g, ''), file, line: i + 1, column: text.indexOf(m[1]!) + 1 });
  });
  return out;
}

/** Resolve a source value ("25", "A0", "GPIO_NUM_25") to a GPIO number on the board. */
export function resolvePinValue(value: string, board: BoardDefinition, registry: HardwareRegistry = getRegistry()): number | null {
  const v = value.replace(/^GPIO_NUM_/, '');
  if (/^\d+$/.test(v)) return Number(v);
  const p = registry.resolveBoardPin(board.id, v);
  return isGpio(p) ? p.gpio : null;
}

export function checkFirmwareSync(opts: {
  files: { path: string; content: string }[];
  configFile: string;
  expected: PinSymbol[];
  board: BoardDefinition;
  registry?: HardwareRegistry;
}): Diagnostic[] {
  const registry = opts.registry ?? getRegistry();
  const out: Diagnostic[] = [];
  const expectedByName = new Map(opts.expected.map((s) => [s.name, s]));
  const defs = opts.files.flatMap((f) => extractDefinitions(f.path, f.content));
  const config = opts.files.find((f) => f.path === opts.configFile);

  for (const def of defs) {
    const exp = expectedByName.get(def.name);
    if (!exp) continue;
    const actual = resolvePinValue(def.value, opts.board, registry);
    if (actual !== exp.gpio) {
      out.push({
        code: 'SYNC_PIN_MISMATCH',
        severity: 'warning',
        source: 'sync',
        message: `${def.name} is ${def.value} in ${def.file}, but the circuit connects ${exp.comment.split(' -> ')[0]} to ${exp.boardPin}`,
        hint: def.file === opts.configFile ? 'Regenerate the pin configuration from the circuit.' : `Use ${exp.value} or include the generated ${opts.configFile}.`,
        target: { file: def.file, line: def.line, column: def.column, ...(exp.componentId ? { componentId: exp.componentId } : {}) },
      });
    }
  }

  if (!config) {
    if (opts.expected.length > 0) {
      out.push({
        code: 'SYNC_CONFIG_MISSING',
        severity: 'info',
        source: 'sync',
        message: `${opts.configFile} does not exist; firmware pin numbers are not linked to the circuit`,
        hint: 'Generate the pin configuration from the circuit.',
      });
    }
  } else {
    const configDefs = new Map(extractDefinitions(config.path, config.content).map((d) => [d.name, d]));
    for (const exp of opts.expected) {
      if (!configDefs.has(exp.name)) {
        out.push({
          code: 'SYNC_SYMBOL_MISSING',
          severity: 'info',
          source: 'sync',
          message: `${exp.name} (${exp.comment}) is not defined in ${opts.configFile}`,
          hint: 'Regenerate the pin configuration from the circuit.',
          target: { file: config.path, ...(exp.componentId ? { componentId: exp.componentId } : {}) },
        });
      }
    }
    if (config.content.includes(GENERATED_MARKER)) {
      for (const d of configDefs.values()) {
        if (!expectedByName.has(d.name) && /_(PIN|SDA|SCL|SCK|MOSI|MISO)$|^(I2C|SPI)_/.test(d.name)) {
          out.push({
            code: 'SYNC_STALE_SYMBOL',
            severity: 'info',
            source: 'sync',
            message: `${d.name} in ${config.path} no longer corresponds to a circuit connection`,
            target: { file: d.file, line: d.line, column: d.column },
          });
        }
      }
    }
  }

  // Hard-coded pin literals in pinMode()/Pin() that are not part of the circuit.
  const known = new Set(opts.expected.map((e) => e.gpio));
  for (const f of opts.files) {
    if (f.path === opts.configFile) continue;
    const re = f.path.endsWith('.py') ? /\bPin\(\s*(\d+)/g : /\bpinMode\(\s*(\d+)\s*,/g;
    f.content.split(/\r?\n/).forEach((text, i) => {
      for (const m of text.matchAll(re)) {
        const gpio = Number(m[1]);
        const bp = opts.board.pins.find((p) => p.gpio === gpio);
        if (known.has(gpio) || bp?.flags?.includes('onboard-led')) continue;
        out.push({
          code: 'SYNC_UNKNOWN_PIN_LITERAL',
          severity: 'info',
          source: 'sync',
          message: `${f.path}:${i + 1} uses pin ${gpio}, which is not connected in the circuit`,
          target: { file: f.path, line: i + 1, column: (m.index ?? 0) + 1 },
        });
      }
    });
  }
  return out;
}
