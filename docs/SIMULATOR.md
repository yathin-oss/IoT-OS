# Simulator

The circuit editor and the simulator share one model: `.iotos/circuit.json`. The canvas is a view over it; every edit is a pure operation from `core/circuit/operations.ts` recorded in undo history.

## Editing

Add (drag from the palette or double-click), move, rotate (`R`, `Shift+R`), duplicate (`⌘/Ctrl+D`), delete (`Del`), wire (click a pin, then another pin; `Esc` cancels), disconnect (inspector), re-assign a component pin to another board pin (inspector), edit properties and labels, change board and radio features, zoom (wheel), pan (drag the background, middle button or Space), undo/redo (`⌘/Ctrl+Z`, `⌘/Ctrl+Shift+Z`). Validation updates live while editing; **Save circuit** writes the model.

## Engine (decision D5)

A hybrid of:

1. **MCU emulation** — `core/sim/avrRuntime.ts` runs the actual compiled firmware (`.hex` from the last successful build) on an ATmega328P emulated by [AVR8js](https://github.com/wokwi/avr8js) (MIT): instruction set, timers 0/1/2 (`millis`, `delay`, `analogWrite` PWM), GPIO ports B/C/D with pull-ups, ADC (`analogRead`) and USART0 (`Serial`, both directions).
2. **Circuit solver** — `core/sim/solver.ts`, a logic-level model over the circuit graph:
   - nets are ideal conductors; pressed buttons merge nets;
   - strong drivers: supply rails, GND, MCU outputs, potentiometer wipers, analog sensor outputs, digital sensor outputs; disagreeing strong drivers are reported as a **short circuit**;
   - weak drivers: MCU pull-ups and values propagated through series resistors into otherwise undriven nets;
   - LEDs light when V(anode) − V(cathode) ≥ 75 % of their forward voltage; brightness follows PWM duty;
   - servos derive their angle from the measured pulse width; buzzers from level/frequency; relays from IN level (active-low aware).
   It is **not SPICE**: no currents or analog transients.

The MCU and the solver run in lock-step slices (4 per 20 ms step) inside a **Web Worker**, paced to real time (0.25×–2×). Pin activity is tracked per cycle to compute duty cycle, frequency and pulse width; a single level change in a window is reported as a level, not PWM.

## Capability matrix

| Board | Firmware execution | Circuit simulation |
|---|---|---|
| Arduino Uno R3, Arduino Nano | ✅ AVR8js (GPIO, PWM, timers, ADC, Serial) | ✅ |
| ESP32 / ESP32-S3 / ESP32-C3, Uno R4 Minima, Raspberry Pi Pico | ❌ (no emulator) | ✅ with manual pin driving (High/Low/PWM/pull-up) in the inspector |

| Component | Simulated |
|---|---|
| LED, resistor, push button, potentiometer, soil moisture, LDR, PIR, relay, active/passive buzzer, SG90 servo | ✅ |
| DHT11/DHT22, HC-SR04 | ❌ protocol timing not emulated (firmware reads fail as with a disconnected sensor) |
| BME280, SSD1306, LCD1602, ST7789 | ❌ I2C/SPI device emulation not implemented |
| Stepper, HC-05, nRF24L01+ | ❌ |

Unsupported parts are labelled "no sim" in the palette and "not simulated" on the canvas — nothing is animated without an underlying model.

## Workflow

1. Build the project (Uno/Nano) — the simulator uses the last successful build and warns if sources changed since.
2. Press **Run**. The banner shows mode, firmware age, simulated time and real-time ratio.
3. Click buttons, drag sliders for analog sensors/potentiometers in the inspector, watch LEDs/servo/relay state and the simulated serial console (with input).
4. Editing the circuit stops the simulation (to avoid showing stale behaviour).
