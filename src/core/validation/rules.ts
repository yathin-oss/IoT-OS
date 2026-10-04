import type { Diagnostic } from '../diagnostics';
import type { Net } from '../circuit/graph';
import type { ComponentPin, PinCapability } from '../registry/types';
import type { ValidationContext, ValidationRule } from './engine';

const d = (x: Omit<Diagnostic, 'source'>): Diagnostic => ({ source: 'hardware', ...x });

const CAPABILITY_ERRORS: Record<PinCapability, { code: string; text: string }> = {
  'digital-out': { code: 'PIN_NOT_OUTPUT', text: 'cannot be used as an output' },
  'digital-in': { code: 'PIN_NOT_INPUT', text: 'cannot be used as a digital input' },
  adc: { code: 'PIN_NO_ADC', text: 'has no analog input (ADC)' },
  dac: { code: 'PIN_NO_DAC', text: 'has no DAC' },
  pwm: { code: 'PIN_NO_PWM', text: 'does not support PWM' },
  touch: { code: 'PIN_NO_TOUCH', text: 'has no capacitive touch' },
  i2c: { code: 'PIN_NO_I2C', text: 'cannot carry I2C on this board' },
  spi: { code: 'PIN_NO_SPI', text: 'cannot carry SPI on this board' },
  uart: { code: 'PIN_NO_UART', text: 'cannot carry UART on this board' },
  interrupt: { code: 'PIN_NO_INTERRUPT', text: 'does not support external interrupts' },
};

function compPin(ctx: ValidationContext, componentId: string, pinId: string): ComponentPin | undefined {
  return ctx.graph.defs.get(componentId)?.pins.find((p) => p.id === pinId);
}

function labelOf(ctx: ValidationContext, componentId: string): string {
  return ctx.graph.instances.get(componentId)?.label ?? componentId;
}

/* ---------------------------------------------------------------------- */

const componentTypes: ValidationRule = {
  id: 'component-types',
  description: 'Every component instance references a known component type.',
  check: (ctx) =>
    ctx.circuit.components
      .filter((c) => !ctx.registry.getComponent(c.type))
      .map((c) =>
        d({
          code: 'COMPONENT_UNKNOWN',
          severity: 'blocking',
          message: `${c.label}: unknown component type "${c.type}"`,
          hint: 'Remove the component or replace it with a type from the component palette.',
          target: { componentId: c.id },
        }),
      ),
};

const wireEndpoints: ValidationRule = {
  id: 'wire-endpoints',
  description: 'Wires connect existing pins.',
  check: (ctx) => {
    const out: Diagnostic[] = [];
    for (const w of ctx.circuit.wires) {
      for (const end of [w.from, w.to]) {
        const r = ctx.graph.resolved.get(`${end.node}:${end.pin}`);
        if (r && r.kind === 'invalid') {
          const what =
            r.reason === 'unknown-node'
              ? `unknown component "${end.node}"`
              : r.reason === 'unknown-type'
                ? `component "${end.node}" of unknown type`
                : end.node === 'board'
                  ? `pin "${end.pin}" which does not exist on ${ctx.board.name}`
                  : `pin "${end.pin}" which does not exist on ${labelOf(ctx, end.node)}`;
          out.push(
            d({
              code: end.node === 'board' && r.reason === 'unknown-pin' ? 'PIN_NOT_ON_BOARD' : 'WIRE_INVALID_ENDPOINT',
              severity: 'error',
              message: `Wire ${w.id} connects to ${what}`,
              target: { wireId: w.id, ...(end.node === 'board' ? { boardPin: end.pin } : { componentId: end.node, componentPin: end.pin }) },
            }),
          );
        }
      }
    }
    return out;
  },
};

const reservedPins: ValidationRule = {
  id: 'reserved-pins',
  description: 'Pins that are internal, wired to flash, or otherwise unavailable.',
  check: (ctx) => {
    const out: Diagnostic[] = [];
    for (const net of ctx.graph.nets) {
      if (net.endpoints.length < 2) continue;
      for (const p of net.boardPins) {
        if (p.flags?.includes('flash')) {
          out.push(d({ code: 'PIN_FLASH', severity: 'blocking', message: `${p.label} is connected to the on-module flash and must not be used`, target: { boardPin: p.id } }));
        }
        if (p.flags?.includes('internal')) {
          out.push(d({ code: 'PIN_INTERNAL', severity: 'error', message: `${p.label} is not available on the board header`, detail: p.notes, target: { boardPin: p.id } }));
        }
      }
    }
    return out;
  },
};

const capabilities: ValidationRule = {
  id: 'pin-capabilities',
  description: 'Component pin requirements match the capabilities of the board pin.',
  check: (ctx) => {
    const out: Diagnostic[] = [];
    for (const b of ctx.pinMap) {
      const cp = compPin(ctx, b.componentId, b.componentPin);
      if (!cp?.requires) continue;
      const label = labelOf(ctx, b.componentId);
      for (const req of cp.requires) {
        if (b.boardPin.capabilities.includes(req)) continue;
        // Bus capability on flexible-mux boards is checked by the bus rule.
        if ((req === 'i2c' || req === 'spi' || req === 'uart') && ctx.board.pinMux === 'flexible' && b.boardPin.capabilities.includes('digital-out')) continue;
        const flags = b.boardPin.flags ?? [];
        let code = CAPABILITY_ERRORS[req].code;
        let text = CAPABILITY_ERRORS[req].text;
        if (flags.includes('input-only') && (req === 'digital-out' || req === 'pwm' || req === 'dac')) {
          code = 'PIN_INPUT_ONLY';
          text = 'is input-only and cannot drive outputs';
        } else if (flags.includes('analog-only')) {
          code = 'PIN_ANALOG_ONLY';
          text = 'is analog-input only';
        }
        out.push(
          d({
            code,
            severity: 'error',
            message: `${label}.${cp.label} needs ${req} but ${b.boardPin.label} ${text}`,
            hint: suggestPins(ctx, cp.requires),
            target: { componentId: b.componentId, componentPin: b.componentPin, boardPin: b.boardPin.id },
          }),
        );
      }
    }
    return out;
  },
};

function suggestPins(ctx: ValidationContext, reqs: PinCapability[]): string {
  const used = new Set(ctx.pinMap.map((b) => b.boardPin.id));
  const candidates = ctx.board.pins.filter(
    (p) =>
      reqs.every((r) => p.capabilities.includes(r) || ((r === 'i2c' || r === 'spi' || r === 'uart') && ctx.board.pinMux === 'flexible')) &&
      !used.has(p.id) &&
      !(p.flags ?? []).some((f) => f === 'strapping' || f === 'usb-serial' || f === 'usb' || f === 'flash' || f === 'internal' || f === 'psram'),
  );
  if (candidates.length === 0) return 'No free pin on this board offers the required capability.';
  return `Free pins with ${reqs.join(' + ')}: ${candidates
    .slice(0, 8)
    .map((p) => p.label)
    .join(', ')}`;
}

const pinRestrictions: ValidationRule = {
  id: 'pin-restrictions',
  description: 'Strapping, USB-serial, USB, PSRAM and ADC2/Wi-Fi restrictions.',
  check: (ctx) => {
    const out: Diagnostic[] = [];
    for (const b of ctx.pinMap) {
      const flags = b.boardPin.flags ?? [];
      const label = `${labelOf(ctx, b.componentId)}.${b.componentPin}`;
      const target = { componentId: b.componentId, componentPin: b.componentPin, boardPin: b.boardPin.id };
      if (flags.includes('strapping')) {
        out.push(d({ code: 'PIN_STRAPPING', severity: 'warning', message: `${label} uses strapping pin ${b.boardPin.label}`, detail: b.boardPin.notes, hint: 'External pull-ups/downs or loads here can prevent booting or flashing. Prefer another pin.', target }));
      }
      if (flags.includes('usb-serial')) {
        out.push(d({ code: 'PIN_USB_SERIAL', severity: 'warning', message: `${label} uses ${b.boardPin.label}, which is shared with the USB serial port`, detail: b.boardPin.notes, hint: 'Uploading and the Serial Monitor may fail while this device is connected.', target }));
      }
      if (flags.includes('usb')) {
        out.push(d({ code: 'PIN_USB', severity: 'warning', message: `${label} uses ${b.boardPin.label}, a native USB data line`, hint: 'Using it disables native USB (and USB serial/flash over it).', target }));
      }
      if (flags.includes('psram')) {
        out.push(d({ code: 'PIN_PSRAM', severity: 'warning', message: `${label} uses ${b.boardPin.label}, which is used by PSRAM on some module variants`, detail: b.boardPin.notes, target }));
      }
      const cp = compPin(ctx, b.componentId, b.componentPin);
      if (flags.includes('adc2-wifi') && cp?.requires?.includes('adc')) {
        out.push(
          d({
            code: 'PIN_ADC2_WIFI',
            severity: ctx.hardware.features.wifi ? 'error' : 'warning',
            message: ctx.hardware.features.wifi
              ? `${label} reads analog values on ${b.boardPin.label} (ADC2), which does not work while Wi-Fi is enabled`
              : `${label} uses ADC2 pin ${b.boardPin.label}; it will stop working if Wi-Fi is enabled`,
            hint: suggestPins(ctx, ['adc']).replace('Free pins', 'Free ADC pins'),
            target,
          }),
        );
      }
    }
    return out;
  },
};

const buses: ValidationRule = {
  id: 'buses',
  description: 'I2C/SPI/UART signals go to compatible pins; default pin usage.',
  check: (ctx) => {
    const out: Diagnostic[] = [];
    for (const b of ctx.pinMap) {
      const cp = compPin(ctx, b.componentId, b.componentPin);
      if (!cp?.bus) continue;
      const { kind, signal } = cp.bus;
      const matching = ctx.board.buses.filter((bus) => bus.kind === kind && bus.pins[signal] === b.boardPin.id);
      const label = `${labelOf(ctx, b.componentId)}.${cp.label}`;
      const target = { componentId: b.componentId, componentPin: b.componentPin, boardPin: b.boardPin.id };
      if (matching.length > 0) continue;
      const expected = ctx.board.buses
        .filter((bus) => bus.kind === kind && bus.pins[signal])
        .map((bus) => `${bus.id}: ${bus.pins[signal]}`)
        .join(', ');
      if (ctx.board.pinMux === 'fixed') {
        out.push(
          d({
            code: 'BUS_PIN_MISMATCH',
            severity: 'error',
            message: `${label} (${kind.toUpperCase()} ${signal.toUpperCase()}) is on ${b.boardPin.label}, but ${ctx.board.name} only provides it on ${expected || 'no pin'}`,
            target,
          }),
        );
      } else {
        out.push(
          d({
            code: 'BUS_NON_DEFAULT_PINS',
            severity: 'info',
            message: `${label} uses non-default ${kind.toUpperCase()} pin ${b.boardPin.label} (default ${expected || 'n/a'})`,
            hint: kind === 'i2c' ? 'Pass the pins explicitly, e.g. Wire.begin(I2C_SDA, I2C_SCL) or I2C(0, sda=Pin(..), scl=Pin(..)).' : 'Pass the pins explicitly when initialising the bus.',
            target,
          }),
        );
      }
    }
    return out;
  },
};

function describeNet(ctx: ValidationContext, net: Net): string {
  return net.endpoints
    .map((e) => (e.kind === 'component' ? `${e.instance.label}.${e.pin.label}` : e.kind === 'board-gpio' || e.kind === 'board-power' ? e.pin.label : e.key))
    .slice(0, 6)
    .join(', ');
}

const nets: ValidationRule = {
  id: 'nets',
  description: 'Shorts, rail conflicts and shorted GPIOs.',
  check: (ctx) => {
    const out: Diagnostic[] = [];
    for (const net of ctx.graph.nets) {
      const rails = net.powerPins.filter((p) => p.kind === 'power');
      if (net.hasGround && rails.length > 0) {
        out.push(d({ code: 'NET_SHORT', severity: 'blocking', message: `Short circuit: ${rails.map((r) => r.label).join(', ')} connected directly to GND`, detail: `Net: ${describeNet(ctx, net)}`, target: { boardPin: rails[0]!.id } }));
      }
      if (net.voltages.length > 1) {
        out.push(d({ code: 'NET_RAIL_CONFLICT', severity: 'blocking', message: `Different supply rails shorted together: ${rails.map((r) => r.label).join(' + ')}`, target: { boardPin: rails[0]!.id } }));
      }
      const gpios = [...new Set(net.boardPins.map((p) => p.id))];
      if (gpios.length > 1) {
        out.push(d({ code: 'NET_GPIO_SHORT', severity: 'error', message: `GPIOs ${gpios.join(', ')} are wired together`, hint: 'If both are outputs driving different levels, this is a short circuit.', target: { boardPin: gpios[0]! } }));
      }
      if (net.boardPins.length > 0 && (rails.length > 0 || net.hasGround)) {
        out.push(
          d({
            code: 'NET_GPIO_TO_RAIL',
            severity: 'warning',
            message: `${net.boardPins[0]!.label} is wired directly to ${net.hasGround ? 'GND' : rails[0]!.label}`,
            hint: 'Configuring this pin as an output driving the opposite level will short it. Use a resistor.',
            target: { boardPin: net.boardPins[0]!.id },
          }),
        );
      }
      // Multiple push-pull signal outputs on one net (buses are open-drain and excluded).
      const drivers = net.endpoints.filter((e) => e.kind === 'component' && e.pin.role === 'signal' && e.pin.outputHigh !== undefined);
      if (drivers.length > 1) {
        out.push(d({ code: 'OUTPUT_CONTENTION', severity: 'warning', message: `Several outputs drive the same net: ${describeNet(ctx, net)}` }));
      }
    }
    return out;
  },
};

const power: ValidationRule = {
  id: 'power',
  description: 'Component supply voltage, grounding and power source.',
  check: (ctx) => {
    const out: Diagnostic[] = [];
    for (const inst of ctx.circuit.components) {
      const def = ctx.graph.defs.get(inst.id);
      if (!def || !def.electrical) continue;
      for (const p of def.pins) {
        const net = ctx.graph.netOf.get(`${inst.id}:${p.id}`);
        if (!net) continue;
        const connected = net.endpoints.length > 1;
        const target = { componentId: inst.id, componentPin: p.id };
        if (p.role === 'ground' && connected && !net.hasGround) {
          const hasRail = net.voltages.length > 0;
          out.push(d({ code: hasRail ? 'GROUND_TO_SUPPLY' : 'GROUND_NOT_GROUNDED', severity: hasRail ? 'blocking' : 'warning', message: `${inst.label}.${p.label} ${hasRail ? 'is connected to a supply rail' : 'is not connected to board GND'}`, target }));
        }
        if (p.role === 'power' && connected) {
          if (net.hasGround) {
            out.push(d({ code: 'SUPPLY_TO_GROUND', severity: 'blocking', message: `${inst.label}.${p.label} is connected to GND`, target }));
          } else if (net.voltages.length === 0 && net.boardPins.length > 0) {
            out.push(d({ code: 'POWER_FROM_GPIO', severity: 'warning', message: `${inst.label} is powered from GPIO ${net.boardPins[0]!.label}`, hint: `GPIOs supply only ~${ctx.board.maxPinCurrentMa ?? 20} mA. Use a power pin.`, target }));
          }
        }
      }
      const v = ctx.supplyOf(inst.id);
      if (v !== null && def.power) {
        if (v > def.power.maxV) {
          out.push(d({ code: 'SUPPLY_OVERVOLTAGE', severity: 'error', message: `${inst.label} is powered from ${v} V but its maximum is ${def.power.maxV} V`, hint: 'This can permanently damage the part. Move its supply to a lower-voltage rail.', target: { componentId: inst.id } }));
        } else if (v < def.power.minV) {
          out.push(d({ code: 'SUPPLY_UNDERVOLTAGE', severity: 'warning', message: `${inst.label} is powered from ${v} V but needs at least ${def.power.minV} V`, hint: 'It may not work reliably. Use a higher-voltage rail (e.g. 5V/VIN).', target: { componentId: inst.id } }));
        }
      }
    }
    return out;
  },
};

const logicLevels: ValidationRule = {
  id: 'logic-levels',
  description: 'Signal voltages are compatible between board and components.',
  check: (ctx) => {
    const out: Diagnostic[] = [];
    const tolerance = ctx.board.fiveVoltTolerant ? 5.5 : ctx.board.logicVoltage + 0.3;
    for (const b of ctx.pinMap) {
      const cp = compPin(ctx, b.componentId, b.componentPin);
      if (!cp) continue;
      const label = `${labelOf(ctx, b.componentId)}.${cp.label}`;
      const target = { componentId: b.componentId, componentPin: b.componentPin, boardPin: b.boardPin.id };
      if (cp.outputHigh !== undefined) {
        const level = cp.outputHigh === 'supply' ? ctx.supplyOf(b.componentId) : cp.outputHigh;
        if (level !== null && level > tolerance) {
          const isBus = cp.role === 'bus';
          out.push(
            d({
              code: 'LOGIC_OVERVOLTAGE',
              severity: isBus ? 'warning' : 'error',
              message: `${label} outputs ${level} V into ${b.boardPin.label}, but ${ctx.board.name} pins tolerate only ${ctx.board.logicVoltage} V`,
              hint: isBus
                ? 'The bus pull-ups are tied to the higher voltage. Use a level shifter or power the module from 3.3 V if it supports it.'
                : 'Add a voltage divider (e.g. 1 kΩ / 2 kΩ) or a level shifter on this signal.',
              target,
            }),
          );
        }
      }
      if (cp.inputMaxV !== undefined && ctx.board.logicVoltage > cp.inputMaxV) {
        out.push(
          d({
            code: 'INPUT_OVERVOLTAGE',
            severity: 'error',
            message: `${b.boardPin.label} drives ${ctx.board.logicVoltage} V into ${label}, which tolerates only ${cp.inputMaxV} V`,
            hint: 'Add a voltage divider or level shifter.',
            target,
          }),
        );
      }
    }
    return out;
  },
};

const ledResistor: ValidationRule = {
  id: 'led-resistor',
  description: 'LEDs driven from GPIOs have a series resistor.',
  check: (ctx) => {
    const out: Diagnostic[] = [];
    for (const inst of ctx.circuit.components) {
      const def = ctx.graph.defs.get(inst.id);
      if (def?.sim.model !== 'led') continue;
      const a = ctx.graph.netOf.get(`${inst.id}:A`);
      const k = ctx.graph.netOf.get(`${inst.id}:K`);
      if (!a || !k) continue;
      const aDirect = a.boardPins.length > 0 || a.voltages.length > 0;
      const kDirect = k.hasGround || k.boardPins.length > 0;
      if (aDirect && kDirect) {
        out.push(d({ code: 'LED_NO_RESISTOR', severity: 'warning', message: `${inst.label} has no series resistor`, hint: 'Add a 220-330 Ω resistor in series to limit current and protect the pin and LED.', target: { componentId: inst.id } }));
      }
      if (a.hasGround && k.boardPins.length === 0 && k.voltages.length > 0) {
        out.push(d({ code: 'LED_REVERSED', severity: 'warning', message: `${inst.label} appears to be reversed (anode to GND, cathode to supply)`, target: { componentId: inst.id } }));
      }
    }
    return out;
  },
};

const i2cAddresses: ValidationRule = {
  id: 'i2c-addresses',
  description: 'Devices sharing an I2C bus use distinct addresses.',
  check: (ctx) => {
    const out: Diagnostic[] = [];
    const byNet = new Map<string, { addr: string; id: string; label: string }[]>();
    for (const inst of ctx.circuit.components) {
      const def = ctx.graph.defs.get(inst.id);
      if (!def?.i2cAddressProp) continue;
      const sda = def.pins.find((p) => p.bus?.kind === 'i2c' && p.bus.signal === 'sda');
      const net = sda ? ctx.graph.netOf.get(`${inst.id}:${sda.id}`) : undefined;
      if (!net || net.endpoints.length < 2) continue;
      const list = byNet.get(net.id) ?? [];
      list.push({ addr: String(inst.props[def.i2cAddressProp] ?? ''), id: inst.id, label: inst.label });
      byNet.set(net.id, list);
    }
    for (const list of byNet.values()) {
      const seen = new Map<string, string>();
      for (const dev of list) {
        const other = seen.get(dev.addr.toLowerCase());
        if (other) {
          out.push(d({ code: 'I2C_ADDRESS_CONFLICT', severity: 'error', message: `${other} and ${dev.label} share I2C address ${dev.addr} on the same bus`, hint: 'Change the address jumper on one module or use a second I2C bus.', target: { componentId: dev.id } }));
        } else seen.set(dev.addr.toLowerCase(), dev.label);
      }
    }
    return out;
  },
};

const currentBudget: ValidationRule = {
  id: 'current-budget',
  description: 'Estimated load on each board supply rail.',
  check: (ctx) => {
    const out: Diagnostic[] = [];
    const load = new Map<string, { ma: number; labels: string[] }>();
    for (const inst of ctx.circuit.components) {
      const def = ctx.graph.defs.get(inst.id);
      if (!def?.power) continue;
      const ma = def.power.peakMa ?? def.power.typicalMa;
      if (!ma) continue;
      const pwr = def.pins.find((p) => p.role === 'power');
      const net = pwr ? ctx.graph.netOf.get(`${inst.id}:${pwr.id}`) : undefined;
      const rail = net?.powerPins.find((p) => p.kind === 'power');
      if (!rail) continue;
      const cur = load.get(rail.id) ?? { ma: 0, labels: [] };
      cur.ma += ma;
      cur.labels.push(inst.label);
      load.set(rail.id, cur);
    }
    for (const [railId, l] of load) {
      const rail = ctx.board.power.find((p) => p.id === railId);
      if (rail?.maxCurrentMa !== undefined && l.ma > rail.maxCurrentMa) {
        out.push(
          d({
            code: 'RAIL_OVERLOAD',
            severity: 'warning',
            message: `Estimated peak load on ${rail.label} is ${Math.round(l.ma)} mA, above its ~${rail.maxCurrentMa} mA budget`,
            detail: `Loads: ${l.labels.join(', ')}. ${rail.notes ?? ''}`.trim(),
            hint: 'Power high-current parts (servos, motors, relays) from a separate supply with a common ground.',
            target: { boardPin: rail.id },
          }),
        );
      }
    }
    return out;
  },
};

const connectivity: ValidationRule = {
  id: 'connectivity',
  description: 'Required component pins are connected.',
  check: (ctx) => {
    const out: Diagnostic[] = [];
    for (const inst of ctx.circuit.components) {
      const def = ctx.graph.defs.get(inst.id);
      if (!def || !def.electrical) continue;
      const pinNets = def.pins.map((p) => ({ p, net: ctx.graph.netOf.get(`${inst.id}:${p.id}`) }));
      const anyConnected = pinNets.some((x) => (x.net?.endpoints.length ?? 0) > 1);
      if (!anyConnected && def.pins.length > 0) {
        out.push(d({ code: 'COMPONENT_UNCONNECTED', severity: 'info', message: `${inst.label} is not connected`, target: { componentId: inst.id } }));
        continue;
      }
      for (const { p, net } of pinNets) {
        if (p.required && (net?.endpoints.length ?? 0) <= 1) {
          out.push(d({ code: 'PIN_UNCONNECTED', severity: 'warning', message: `${inst.label}.${p.label} is not connected`, target: { componentId: inst.id, componentPin: p.id } }));
        }
      }
    }
    return out;
  },
};

const boardFeatures: ValidationRule = {
  id: 'board-features',
  description: 'Hardware features used by the project exist on the board.',
  check: (ctx) => {
    const out: Diagnostic[] = [];
    if (ctx.hardware.features.wifi && !ctx.board.wifi) {
      out.push(d({ code: 'FEATURE_UNSUPPORTED', severity: 'error', message: `${ctx.board.name} has no Wi-Fi`, hint: 'Choose an ESP32-family board or add a Wi-Fi module.' }));
    }
    if (ctx.hardware.features.bluetooth && !ctx.board.bluetooth) {
      out.push(d({ code: 'FEATURE_UNSUPPORTED', severity: 'error', message: `${ctx.board.name} has no Bluetooth`, hint: 'Choose an ESP32-family board or add a Bluetooth module (e.g. HC-05).' }));
    }
    return out;
  },
};

const onboardLed: ValidationRule = {
  id: 'onboard-led',
  description: 'Pins shared with on-board LEDs.',
  check: (ctx) =>
    ctx.pinMap
      .filter((b) => (b.boardPin.flags ?? []).includes('onboard-led'))
      .filter((b) => compPin(ctx, b.componentId, b.componentPin)?.requires?.includes('digital-in'))
      .map((b) =>
        d({
          code: 'PIN_ONBOARD_LED',
          severity: 'info',
          message: `${labelOf(ctx, b.componentId)} reads ${b.boardPin.label}, which also drives the on-board LED`,
          hint: 'The LED load can affect input readings, especially with weak pull-ups.',
          target: { componentId: b.componentId, componentPin: b.componentPin, boardPin: b.boardPin.id },
        }),
      ),
};

export const RULES: ValidationRule[] = [
  componentTypes,
  wireEndpoints,
  reservedPins,
  capabilities,
  pinRestrictions,
  buses,
  nets,
  power,
  logicLevels,
  ledResistor,
  i2cAddresses,
  currentBudget,
  connectivity,
  boardFeatures,
  onboardLed,
];

