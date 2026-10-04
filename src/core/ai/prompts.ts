import { getRegistry, type HardwareRegistry } from '../registry/registry';
import type { BoardDefinition } from '../registry/types';

/**
 * Prompt text for IoT-OS AI tasks. Kept deterministic (no timestamps or ids) so
 * provider-side prompt caching stays effective.
 */

export const BASE_SYSTEM = `You are the IoT-OS engineering copilot inside an IoT development environment (Arduino C++, ESP32 C++, MicroPython).
You understand firmware, GPIO/I2C/SPI/UART/ADC/PWM, board pin restrictions, circuits, libraries, compiler output and serial logs.
Ground every answer in the PROJECT CONTEXT provided. Key rules:
- Distinguish clearly between what is OBSERVED in the context, what is LIKELY, and what is an ASSUMPTION. Never claim certainty you do not have.
- The circuit (.iotos/circuit.json) is the source of truth for wiring. Pin numbers reach firmware through a generated config file (include/config.h or src/config.py); never hard-code pin numbers and never edit that generated file.
- Deterministic hardware validation results in the context are authoritative; do not contradict them.
- You cannot run commands, install software or flash devices. When such an action is needed, say exactly what the user should run or click in IoT-OS.
- Be concise and technical. Use Markdown; put code in fenced blocks.`;

export const JSON_RULES = `Respond with a single JSON object only, no prose before or after it. Do not wrap it in commentary.`;

/** Compact catalog of boards for project planning. */
export function boardCatalog(registry: HardwareRegistry = getRegistry()): string {
  return registry
    .listBoards()
    .map((b) => `- ${b.id}: ${b.name}; ${b.mcu}; ${b.logicVoltage} V logic; Wi-Fi ${b.wifi ? 'yes' : 'no'}; BT ${b.bluetooth ? 'yes' : 'no'}; languages: ${b.languages.join(', ')}`)
    .join('\n');
}

/** Compact catalog of components with pins, roles and firmware symbol suffixes. */
export function componentCatalog(registry: HardwareRegistry = getRegistry()): string {
  return registry
    .listComponents()
    .filter((c) => c.electrical)
    .map((c) => {
      const pins = c.pins
        .map((p) => `${p.id}(${p.role}${p.requires ? `; needs ${p.requires.join('+')}` : ''}${p.bus ? `; ${p.bus.kind} ${p.bus.signal}` : ''})`)
        .join(', ');
      const power = c.power ? ` supply ${c.power.minV}-${c.power.maxV} V.` : '';
      const props = c.props.filter((p) => !p.simulation).map((p) => `${p.key}=${String(p.default)}`);
      const syms = c.firmware.symbols.map((s) => `<ID>_${s.suffix} for ${s.pin}`);
      return `- ${c.type}: ${c.name}.${power} Pins: ${pins}.${props.length ? ` Props: ${props.join(', ')}.` : ''}${syms.length ? ` Firmware symbols: ${syms.join(', ')}.` : ''}`;
    })
    .join('\n');
}

/** Pin table for one board, including restrictions. */
export function boardPinTable(board: BoardDefinition): string {
  const pins = board.pins
    .filter((p) => !(p.flags ?? []).includes('internal'))
    .map((p) => `${p.id}${p.label !== p.id ? ` (${p.label})` : ''}: ${p.capabilities.join(',')}${p.flags?.length ? ` [${p.flags.join(',')}]` : ''}`);
  const power = board.power.map((p) => `${p.id}${p.voltage ? ` ${p.voltage}V` : ''} (${p.kind})`);
  const buses = board.buses.map((b) => `${b.id} ${b.kind}: ${Object.entries(b.pins).map(([k, v]) => `${k}=${v}`).join(' ')}${b.isDefault ? ' (default)' : ''}`);
  return [`Board ${board.id} — ${board.name}; pin mux: ${board.pinMux}`, 'GPIO pins:', ...pins, `Power pins: ${power.join(', ')}`, `Buses: ${buses.join('; ')}`].join('\n');
}

export const WIRING_RULES = `Wiring conventions:
- Endpoints are written "componentId.PIN" or "board.PIN" (use board pin ids exactly as listed, e.g. board.GPIO25, board.D9, board.A0, board.GP15, board.3V3, board.5V, board.GND).
- Every component power pin goes to a board power pin of a compatible voltage and every ground pin to board.GND.
- LEDs need a series resistor (e.g. 220 Ω): board.GPIOx -> r1.1, r1.2 -> led1.A, led1.K -> board.GND.
- Buttons go between a GPIO and GND (firmware uses INPUT_PULLUP / Pin.PULL_UP).
- Avoid strapping, USB-serial, flash, PSRAM and USB pins. On ESP32 boards with Wi-Fi use ADC1 pins for analog inputs.
- Respect voltage levels: 5 V outputs (e.g. HC-SR04 ECHO) must not go directly into 3.3 V boards.`;

export const FIRMWARE_RULES = `Firmware conventions:
- Arduino C++: the entry file is src/main.cpp. Start with #include <Arduino.h> and #include "config.h".
- MicroPython: the entry file is src/main.py and imports pins with "from config import ...".
- The pin config file is GENERATED from the circuit; do not include it in your files. Symbols are the component id in upper case plus the symbol suffix (led1 -> LED1_PIN, sonar1 -> SONAR1_TRIG_PIN). I2C devices use I2C_SDA / I2C_SCL; SPI buses use SPI_SCK / SPI_MOSI / SPI_MISO.
- Use Serial at 115200 baud for logs. Print sensor values as "name:value name2:value2" lines so the IoT-OS Serial Plotter can graph them.
- Use only libraries that exist in the Arduino Library Manager (or micropython-lib for mip) and list them as dependencies.`;
