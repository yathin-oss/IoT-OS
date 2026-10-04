# Project format (schema version 1)

```
<project>/
├── .iotos/
│   ├── project.json      manifest
│   ├── hardware.json     target board + hardware settings
│   ├── circuit.json      circuit graph (connectivity source of truth)
│   └── build/            generated (git-ignored): staged sketch, outputs, last-build.json
├── src/                  firmware (main.cpp or main.py — only the one for the project language)
├── include/config.h      GENERATED pin configuration (Arduino C++)
│   (src/config.py for MicroPython)
├── lib/                  project-local libraries (passed to the compiler)
└── docs/HARDWARE.md, docs/SETUP.md   generated docs (regenerable)
```

All three JSON files carry `schemaVersion`. Loading runs: JSON parse → version check → migrations → zod schema validation. Errors are classified:

| Code | Meaning |
|---|---|
| `PROJECT_MANIFEST_MISSING` | not an IoT-OS project |
| `PROJECT_INVALID_JSON` | corrupted/partially written file |
| `PROJECT_SCHEMA_INVALID` | field errors (paths listed) |
| `PROJECT_VERSION_UNSUPPORTED` | written by a newer IoT-OS, or no migration path |

A missing `circuit.json` is recovered (empty circuit + warning). Migrations are registered in `core/project/migrations.ts` (`MIGRATIONS`), one step per version.

## project.json

```json
{
  "schemaVersion": 1,
  "id": "uuid",
  "name": "Plant monitor",
  "description": "",
  "language": "arduino-cpp",              // or "micropython"
  "createdAt": "ISO-8601", "updatedAt": "ISO-8601",
  "firmware": { "entry": "src/main.cpp", "configFile": "include/config.h" },
  "dependencies": [ { "ecosystem": "arduino", "name": "DHT sensor library", "version": "1.4.6" } ],
  "toolchain": { "boardOptions": { "cpu": "atmega328old" } },   // appended to the FQBN
  "runtime": { "port": "/dev/cu.usbserial-0001", "baud": 115200 },
  "docs": ["docs/HARDWARE.md", "docs/SETUP.md"],
  "tags": [], "template": "plant-monitor"
}
```

## hardware.json

```json
{ "schemaVersion": 1, "boardId": "esp32-devkit-v1", "features": { "wifi": true, "bluetooth": false }, "powerSource": "usb", "notes": "" }
```

`features.wifi` matters for validation (ESP32 ADC2 is unusable with Wi-Fi).

## circuit.json

```json
{
  "schemaVersion": 1,
  "board": { "x": 0, "y": 0 },
  "components": [
    { "id": "led1", "type": "led", "label": "LED1", "props": { "color": "red" }, "x": 320, "y": 0, "rotation": 0 },
    { "id": "r1", "type": "resistor", "label": "R1", "props": { "resistance": 220 }, "x": 320, "y": 110, "rotation": 0 }
  ],
  "wires": [
    { "id": "w1", "from": { "node": "board", "pin": "GPIO25" }, "to": { "node": "r1", "pin": "1" }, "color": "#3e8ef7" },
    { "id": "w2", "from": { "node": "r1", "pin": "2" }, "to": { "node": "led1", "pin": "A" } },
    { "id": "w3", "from": { "node": "led1", "pin": "K" }, "to": { "node": "board", "pin": "GND" } }
  ]
}
```

Endpoints are `board` (pin id or alias from the registry) or a component id with a pin id from its definition.

## Generated pin configuration

Symbols are `<LABEL>_<SUFFIX>` from the component definition (e.g. `LED1_PIN`, `SONAR1_TRIG_PIN`), plus bus symbols `I2C_SDA`, `I2C_SCL`, `SPI_SCK`, `SPI_MOSI`, `SPI_MISO`:

```c
// IoT-OS generated pin configuration — regenerate instead of editing by hand.
#pragma once
#define LED1_PIN 25   // LED1.A -> D25 (via R1)
```

Firmware/circuit drift (`SYNC_PIN_MISMATCH`, `SYNC_SYMBOL_MISSING`, `SYNC_STALE_SYMBOL`, `SYNC_UNKNOWN_PIN_LITERAL`, `SYNC_CONFIG_MISSING`) is reported in Problems; **Sync pins** regenerates the file as a reviewable proposal.
