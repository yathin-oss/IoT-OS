# Hardware registry & validation

## Boards

| id | Board | Logic | Languages | Firmware simulation | Build/flash support |
|---|---|---|---|---|---|
| `esp32-devkit-v1` | ESP32 DevKit V1 (DOIT 30-pin) | 3.3 V | C++, MicroPython | circuit-only | supported (not hardware-verified here) |
| `esp32-s3-devkitc-1` | ESP32-S3-DevKitC-1 | 3.3 V | C++, MicroPython | circuit-only | supported (not hardware-verified here) |
| `esp32-c3-devkitm-1` | ESP32-C3-DevKitM-1 | 3.3 V | C++, MicroPython | circuit-only | supported (not hardware-verified here) |
| `arduino-uno-r3` | Arduino Uno R3 | 5 V | C++ | **ATmega328P (AVR8js)** | supported (not hardware-verified here) |
| `arduino-uno-r4-minima` | Arduino Uno R4 Minima | 5 V | C++ | circuit-only | flash marked *untested* (confirmation required) |
| `arduino-nano` | Arduino Nano (ATmega328P) | 5 V | C++ | **ATmega328P (AVR8js)** | supported (not hardware-verified here) |
| `rpi-pico` | Raspberry Pi Pico | 3.3 V | MicroPython, C++ | circuit-only | supported (not hardware-verified here) |

Each `BoardDefinition` (see `core/registry/types.ts`) contains: MCU, clock, memory, logic voltage, 5 V tolerance, per-pin capabilities (`digital-in/out`, `adc`, `dac`, `pwm`, `touch`, `i2c`, `spi`, `uart`, `interrupt`), ADC unit/channel, DAC/touch channels, restriction flags, power pins with voltages and current budgets, buses (default and alternates), header order for rendering, pin-mux model (`fixed` vs `flexible`), toolchain (FQBN, core, Boards Manager URL), MicroPython firmware flashing method, USB VID/PID identification, simulation backend and support level, and datasheet references.

Pin flags interpreted generically by the validator: `input-only`, `strapping`, `flash`, `psram`, `usb-serial`, `usb`, `adc2-wifi`, `no-pullup`, `analog-only`, `onboard-led`, `internal`.

Pins resolve by id or alias, case-insensitively (`25`, `D25`, `IO25` → `GPIO25`; `SDA` → `A4` on the Uno).

The registry constructor verifies every definition (duplicate ids/aliases, header and bus references). Data was authored from the vendor references listed in each definition; please report discrepancies with your board revision.

## Components (21)

LED, resistor, push button, potentiometer, breadboard (layout aid), DHT11, DHT22, BME280, capacitive soil moisture, LDR module, HC-SR04, PIR HC-SR501, SSD1306 OLED (I2C), LCD1602 + PCF8574 (I2C), ST7789 TFT (SPI), SG90 servo, relay module, active/passive buzzer, 28BYJ-48 + ULN2003, HC-05, nRF24L01+.

Each `ComponentDefinition` declares pins with roles (`power`, `ground`, `signal`, `bus`, `passive`), required board capabilities, bus kind/signal, output high level (`supply` or volts), input tolerance, supply range and current, I2C address property, properties (hardware and simulation stimuli), firmware libraries per architecture with the headers they provide, MicroPython modules/mip packages, firmware symbols, simulation model and render hints.

## Adding a board

1. Create `core/registry/boards/<family>.ts` exporting a `BoardDefinition` (use `pin()` / `espGpio()` helpers).
2. Add it to `BUILTIN_BOARDS` in `core/registry/registry.ts`.
3. Run `npm test` — the registry tests and the "every template validates on every supported board" test catch most mistakes.

## Validation rules (`core/validation/rules.ts`)

| Code | Severity | Detects |
|---|---|---|
| `BOARD_UNKNOWN`, `COMPONENT_UNKNOWN` | blocking | model references unknown hardware |
| `WIRE_INVALID_ENDPOINT`, `PIN_NOT_ON_BOARD` | error | wire to a pin/component that does not exist |
| `PIN_FLASH` / `PIN_INTERNAL` | blocking / error | flash-connected or non-header pins |
| `PIN_INPUT_ONLY`, `PIN_ANALOG_ONLY`, `PIN_NO_ADC`, `PIN_NO_PWM`, `PIN_NO_DAC`, `PIN_NOT_OUTPUT`… | error | component needs a capability the pin lacks (with free-pin suggestions) |
| `PIN_STRAPPING`, `PIN_USB_SERIAL`, `PIN_USB`, `PIN_PSRAM` | warning | boot/upload/USB/PSRAM conflicts |
| `PIN_ADC2_WIFI` | error with Wi-Fi, else warning | ESP32 ADC2 analog read with Wi-Fi |
| `BUS_PIN_MISMATCH` / `BUS_NON_DEFAULT_PINS` | error (fixed mux) / info (flexible) | I2C/SPI/UART signal on the wrong pin |
| `NET_SHORT`, `NET_RAIL_CONFLICT` | blocking | supply shorted to GND / two rails joined |
| `NET_GPIO_SHORT`, `NET_GPIO_TO_RAIL`, `OUTPUT_CONTENTION` | error / warning / warning | shorted GPIOs, GPIO tied to a rail, multiple drivers |
| `SUPPLY_OVERVOLTAGE` / `SUPPLY_UNDERVOLTAGE` | error / warning | component supply outside its range |
| `SUPPLY_TO_GROUND`, `GROUND_TO_SUPPLY`, `GROUND_NOT_GROUNDED`, `POWER_FROM_GPIO` | blocking / blocking / warning / warning | power pin mistakes |
| `LOGIC_OVERVOLTAGE` | error (signal) / warning (bus pull-ups) | e.g. HC-SR04 ECHO 5 V into a 3.3 V ESP32 |
| `INPUT_OVERVOLTAGE` | error | 5 V board driving a 3.6 V input (e.g. HC-05 RXD) |
| `LED_NO_RESISTOR`, `LED_REVERSED` | warning | LED wiring |
| `I2C_ADDRESS_CONFLICT` | error | two devices with one address on a bus |
| `RAIL_OVERLOAD` | warning | estimated peak current over a rail's budget |
| `PIN_UNCONNECTED` / `COMPONENT_UNCONNECTED` | warning / info | incomplete wiring |
| `FEATURE_UNSUPPORTED` | error | Wi-Fi/Bluetooth on a board without it |
| `PIN_ONBOARD_LED` | info | input sharing the on-board LED pin |

### Gating policy

- **Build** is blocked only by BLOCKING diagnostics (compiling is harmless).
- **Upload** is blocked by BLOCKING; ERROR requires explicit confirmation ("your physical wiring differs from the model").
- WARNING and INFO never block.
