import { pickPin } from '../circuit/layout';
import { IotosError } from '../errors';
import type { ProjectSpec } from '../project/factory';
import { getRegistry, type HardwareRegistry } from '../registry/registry';
import type { BoardDefinition, Language, PinCapability } from '../registry/types';

/**
 * Project templates. Each template builds a ProjectSpec for a chosen board,
 * picking valid pins from the board registry instead of hard-coding them.
 */

type TemplateSpec = Omit<ProjectSpec, 'name'>;

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  languages: Language[];
  /** Restrict to these architectures; omitted = any board supporting the language. */
  architectures?: BoardDefinition['architecture'][];
  /** Suggested default board. */
  defaultBoard: string;
  tags: string[];
  build(board: BoardDefinition, language: Language): TemplateSpec;
}

class PinAllocator {
  private used = new Set<string>();
  constructor(
    private readonly board: BoardDefinition,
    private readonly wifi = false,
  ) {}
  take(caps: PinCapability[], prefer: string[] = []): string {
    const p = pickPin(this.board, caps, this.used, { avoidAdc2: this.wifi || this.board.wifi, prefer });
    if (!p) throw new IotosError('INVALID_ARGUMENT', `${this.board.name} has no free pin with ${caps.join(' + ')}`);
    this.used.add(p.id);
    return p.id;
  }
}

function powerPin(board: BoardDefinition, volts: number): string {
  const exact = board.power.find((p) => p.kind === 'power' && p.voltage === volts && (p.maxCurrentMa ?? 1) > 0);
  if (exact) return exact.id;
  const any = board.power.find((p) => p.kind === 'power' && (p.maxCurrentMa ?? 1) > 0);
  return any!.id;
}

/** 5 V-ish rail for parts that need it (VIN/5V/VBUS); falls back to the logic rail. */
function fiveVolt(board: BoardDefinition): string {
  return board.power.find((p) => p.kind === 'power' && p.voltage === 5 && p.id !== 'IOREF')?.id ?? powerPin(board, board.logicVoltage);
}

const CPP_HEADER = '#include <Arduino.h>\n#include "config.h"\n';

const blink: ProjectTemplate = {
  id: 'blink',
  name: 'Blink LED',
  description: 'An external LED with a series resistor, blinking once per second, with serial logging.',
  languages: ['arduino-cpp', 'micropython'],
  defaultBoard: 'esp32-devkit-v1',
  tags: ['beginner', 'gpio'],
  build(board, language): TemplateSpec {
    const pins = new PinAllocator(board);
    const led = pins.take(['digital-out', 'pwm'], ['GPIO25', 'D9', 'GP15', 'GPIO4', 'GPIO3']);
    const files: Record<string, string> =
      language === 'micropython'
        ? {
            'src/main.py': `from machine import Pin\nimport time\nfrom config import LED1_PIN\n\nled = Pin(LED1_PIN, Pin.OUT)\nprint("IoT-OS blink started")\n\nwhile True:\n    led.value(1)\n    print("LED on")\n    time.sleep(0.5)\n    led.value(0)\n    print("LED off")\n    time.sleep(0.5)\n`,
          }
        : {
            'src/main.cpp': `${CPP_HEADER}\nvoid setup() {\n  Serial.begin(115200);\n  pinMode(LED1_PIN, OUTPUT);\n  Serial.println("IoT-OS blink started");\n}\n\nvoid loop() {\n  digitalWrite(LED1_PIN, HIGH);\n  Serial.println("LED on");\n  delay(500);\n  digitalWrite(LED1_PIN, LOW);\n  Serial.println("LED off");\n  delay(500);\n}\n`,
          };
    return {
      description: this.description,
      language,
      boardId: board.id,
      components: [
        { id: 'led1', type: 'led', props: { color: 'red' } },
        { id: 'r1', type: 'resistor', props: { resistance: 220 } },
      ],
      connections: [
        { from: { node: 'board', pin: led }, to: { node: 'r1', pin: '1' } },
        { from: { node: 'r1', pin: '2' }, to: { node: 'led1', pin: 'A' } },
        { from: { node: 'led1', pin: 'K' }, to: { node: 'board', pin: 'GND' } },
      ],
      files,
      template: this.id,
      tags: this.tags,
    };
  },
};

const buttonLed: ProjectTemplate = {
  id: 'button-led',
  name: 'Button + LED',
  description: 'A push button (INPUT_PULLUP) toggles an LED; state changes are logged to serial.',
  languages: ['arduino-cpp', 'micropython'],
  defaultBoard: 'arduino-uno-r3',
  tags: ['beginner', 'input'],
  build(board, language): TemplateSpec {
    const pins = new PinAllocator(board);
    const btn = pins.take(['digital-in'], ['D2', 'GPIO27', 'GP14', 'GPIO5', 'GPIO10']);
    const led = pins.take(['digital-out'], ['D9', 'GPIO25', 'GP15', 'GPIO4', 'GPIO3']);
    const files: Record<string, string> =
      language === 'micropython'
        ? {
            'src/main.py': `from machine import Pin\nimport time\nfrom config import BTN1_PIN, LED1_PIN\n\nbutton = Pin(BTN1_PIN, Pin.IN, Pin.PULL_UP)\nled = Pin(LED1_PIN, Pin.OUT)\nlast = button.value()\nstate = 0\n\nwhile True:\n    now = button.value()\n    if last == 1 and now == 0:\n        state ^= 1\n        led.value(state)\n        print("button pressed, led =", state)\n    last = now\n    time.sleep_ms(20)\n`,
          }
        : {
            'src/main.cpp': `${CPP_HEADER}\nbool ledOn = false;\nint lastButton = HIGH;\n\nvoid setup() {\n  Serial.begin(115200);\n  pinMode(BTN1_PIN, INPUT_PULLUP);\n  pinMode(LED1_PIN, OUTPUT);\n  Serial.println("Press the button to toggle the LED");\n}\n\nvoid loop() {\n  int now = digitalRead(BTN1_PIN);\n  if (lastButton == HIGH && now == LOW) {\n    ledOn = !ledOn;\n    digitalWrite(LED1_PIN, ledOn ? HIGH : LOW);\n    Serial.print("button pressed, led = ");\n    Serial.println(ledOn ? "on" : "off");\n  }\n  lastButton = now;\n  delay(20);\n}\n`,
          };
    return {
      description: this.description,
      language,
      boardId: board.id,
      components: [
        { id: 'btn1', type: 'push-button' },
        { id: 'led1', type: 'led', props: { color: 'green' } },
        { id: 'r1', type: 'resistor', props: { resistance: 220 } },
      ],
      connections: [
        { from: { node: 'board', pin: btn }, to: { node: 'btn1', pin: '1' } },
        { from: { node: 'btn1', pin: '2' }, to: { node: 'board', pin: 'GND' } },
        { from: { node: 'board', pin: led }, to: { node: 'r1', pin: '1' } },
        { from: { node: 'r1', pin: '2' }, to: { node: 'led1', pin: 'A' } },
        { from: { node: 'led1', pin: 'K' }, to: { node: 'board', pin: 'GND' } },
      ],
      files,
      template: this.id,
      tags: this.tags,
    };
  },
};

const potDimmer: ProjectTemplate = {
  id: 'pot-dimmer',
  name: 'Potentiometer Dimmer',
  description: 'Reads a potentiometer on an ADC pin, sets LED brightness with PWM and streams values for the Serial Plotter.',
  languages: ['arduino-cpp'],
  defaultBoard: 'arduino-uno-r3',
  tags: ['analog', 'pwm', 'plotter'],
  build(board, language): TemplateSpec {
    const pins = new PinAllocator(board);
    const pot = pins.take(['adc'], ['A0', 'GPIO34', 'GP26', 'GPIO1', 'GPIO0']);
    const led = pins.take(['digital-out', 'pwm'], ['D9', 'GPIO25', 'GP15', 'GPIO4', 'GPIO3']);
    const adcMax = board.architecture === 'avr' || board.architecture === 'renesas_uno' ? 1023 : board.architecture === 'rp2040' ? 1023 : 4095;
    return {
      description: this.description,
      language,
      boardId: board.id,
      components: [
        { id: 'pot1', type: 'potentiometer' },
        { id: 'led1', type: 'led', props: { color: 'yellow' } },
        { id: 'r1', type: 'resistor', props: { resistance: 220 } },
      ],
      connections: [
        { from: { node: 'board', pin: powerPin(board, board.logicVoltage) }, to: { node: 'pot1', pin: 'VCC' } },
        { from: { node: 'pot1', pin: 'GND' }, to: { node: 'board', pin: 'GND' } },
        { from: { node: 'pot1', pin: 'SIG' }, to: { node: 'board', pin: pot } },
        { from: { node: 'board', pin: led }, to: { node: 'r1', pin: '1' } },
        { from: { node: 'r1', pin: '2' }, to: { node: 'led1', pin: 'A' } },
        { from: { node: 'led1', pin: 'K' }, to: { node: 'board', pin: 'GND' } },
      ],
      files: {
        'src/main.cpp': `${CPP_HEADER}\nconst int ADC_MAX = ${adcMax};\n\nvoid setup() {\n  Serial.begin(115200);\n  pinMode(LED1_PIN, OUTPUT);\n}\n\nvoid loop() {\n  int raw = analogRead(POT1_PIN);\n  int duty = map(raw, 0, ADC_MAX, 0, 255);\n  analogWrite(LED1_PIN, duty);\n  // "name:value" pairs are understood by the IoT-OS Serial Plotter.\n  Serial.print("pot:");\n  Serial.print(raw);\n  Serial.print(" duty:");\n  Serial.println(duty);\n  delay(50);\n}\n`,
      },
      template: this.id,
      tags: this.tags,
    };
  },
};

const plantMonitor: ProjectTemplate = {
  id: 'plant-monitor',
  name: 'Smart Plant Monitor',
  description: 'Soil moisture, DHT22 temperature/humidity, SSD1306 OLED and a relay-driven pump with automatic watering.',
  languages: ['arduino-cpp'],
  architectures: ['esp32', 'esp32s3', 'esp32c3'],
  defaultBoard: 'esp32-devkit-v1',
  tags: ['sensors', 'display', 'automation'],
  build(board, language): TemplateSpec {
    const pins = new PinAllocator(board, true);
    const soil = pins.take(['adc'], ['GPIO34', 'GPIO1', 'GPIO0']);
    const dht = pins.take(['digital-in', 'digital-out'], ['GPIO4', 'GPIO6', 'GPIO10']);
    const relay = pins.take(['digital-out'], ['GPIO26', 'GPIO7', 'GPIO3']);
    const i2c = board.buses.find((b) => b.kind === 'i2c' && b.isDefault)!;
    return {
      description: this.description,
      language,
      boardId: board.id,
      components: [
        { id: 'soil1', type: 'soil-moisture-capacitive' },
        { id: 'dht1', type: 'dht22' },
        { id: 'oled1', type: 'ssd1306-i2c' },
        { id: 'relay1', type: 'relay-module' },
      ],
      connections: [
        { from: { node: 'board', pin: '3V3' }, to: { node: 'soil1', pin: 'VCC' } },
        { from: { node: 'soil1', pin: 'GND' }, to: { node: 'board', pin: 'GND' } },
        { from: { node: 'soil1', pin: 'AOUT' }, to: { node: 'board', pin: soil } },
        { from: { node: 'board', pin: '3V3' }, to: { node: 'dht1', pin: 'VCC' } },
        { from: { node: 'dht1', pin: 'GND' }, to: { node: 'board', pin: 'GND' } },
        { from: { node: 'dht1', pin: 'DATA' }, to: { node: 'board', pin: dht } },
        { from: { node: 'board', pin: '3V3' }, to: { node: 'oled1', pin: 'VCC' } },
        { from: { node: 'oled1', pin: 'GND' }, to: { node: 'board', pin: 'GND' } },
        { from: { node: 'oled1', pin: 'SDA' }, to: { node: 'board', pin: i2c.pins['sda']! } },
        { from: { node: 'oled1', pin: 'SCL' }, to: { node: 'board', pin: i2c.pins['scl']! } },
        { from: { node: 'board', pin: fiveVolt(board) }, to: { node: 'relay1', pin: 'VCC' } },
        { from: { node: 'relay1', pin: 'GND' }, to: { node: 'board', pin: 'GND' } },
        { from: { node: 'relay1', pin: 'IN' }, to: { node: 'board', pin: relay } },
      ],
      files: {
        'src/main.cpp': `${CPP_HEADER}#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>

// Calibrate these two readings for your sensor: value in air (dry) and in water (wet).
const int SOIL_DRY = 3000;
const int SOIL_WET = 1200;
const int WATER_BELOW_PERCENT = 35;
const unsigned long PUMP_RUN_MS = 3000;
const unsigned long PUMP_COOLDOWN_MS = 60000;

Adafruit_SSD1306 display(128, 64, &Wire, -1);
DHT dht(DHT1_PIN, DHT22);
unsigned long lastWatering = 0;

void setPump(bool on) {
  // Relay modules are usually active LOW.
  digitalWrite(RELAY1_PIN, on ? LOW : HIGH);
}

int soilPercent() {
  int raw = analogRead(SOIL1_PIN);
  return constrain(map(raw, SOIL_DRY, SOIL_WET, 0, 100), 0, 100);
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY1_PIN, OUTPUT);
  setPump(false);
  dht.begin();
  Wire.begin(I2C_SDA, I2C_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 allocation failed");
  }
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
}

void loop() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  int soil = soilPercent();
  if (isnan(t) || isnan(h)) {
    Serial.println("Failed to read from DHT sensor");
  }
  Serial.print("soil:"); Serial.print(soil);
  Serial.print(" temp:"); Serial.print(t);
  Serial.print(" hum:"); Serial.println(h);

  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.printf("Soil  %3d %%\\nTemp  %.1f C\\nHum   %.0f %%\\n", soil, t, h);
  display.display();

  unsigned long now = millis();
  if (soil < WATER_BELOW_PERCENT && now - lastWatering > PUMP_COOLDOWN_MS) {
    Serial.println("Watering...");
    setPump(true);
    delay(PUMP_RUN_MS);
    setPump(false);
    lastWatering = now;
  }
  delay(2000);
}
`,
      },
      template: this.id,
      tags: this.tags,
    };
  },
};

const empty: ProjectTemplate = {
  id: 'empty',
  name: 'Empty Project',
  description: 'A minimal firmware skeleton with no circuit.',
  languages: ['arduino-cpp', 'micropython'],
  defaultBoard: 'esp32-devkit-v1',
  tags: [],
  build(board, language): TemplateSpec {
    return {
      language,
      boardId: board.id,
      components: [],
      connections: [],
      files:
        language === 'micropython'
          ? { 'src/main.py': 'import time\n\nprint("Hello from IoT-OS")\n\nwhile True:\n    time.sleep(1)\n' }
          : { 'src/main.cpp': `${CPP_HEADER}\nvoid setup() {\n  Serial.begin(115200);\n  Serial.println("Hello from IoT-OS");\n}\n\nvoid loop() {\n}\n` },
      template: this.id,
    };
  },
};

export const TEMPLATES: ProjectTemplate[] = [empty, blink, buttonLed, potDimmer, plantMonitor];

export function getTemplate(id: string): ProjectTemplate {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new IotosError('INVALID_ARGUMENT', `Unknown template "${id}"`);
  return t;
}

export function templateSupports(t: ProjectTemplate, board: BoardDefinition, language: Language): boolean {
  return t.languages.includes(language) && board.languages.includes(language) && (!t.architectures || t.architectures.includes(board.architecture));
}

export function templateSpec(templateId: string, name: string, boardId: string, language: Language, registry: HardwareRegistry = getRegistry()): ProjectSpec {
  const t = getTemplate(templateId);
  const board = registry.requireBoard(boardId);
  if (!templateSupports(t, board, language)) {
    throw new IotosError('INVALID_ARGUMENT', `Template "${t.name}" does not support ${board.name} with ${language}`);
  }
  return { ...t.build(board, language), name };
}
