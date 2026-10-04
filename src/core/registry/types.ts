/**
 * Data model for the hardware registry. Boards and components are pure data;
 * validation, rendering, firmware generation and simulation all interpret these
 * definitions generically. Adding a board or component never requires code changes
 * elsewhere unless it introduces a genuinely new capability.
 */

export const LANGUAGES = ['arduino-cpp', 'micropython'] as const;
export type Language = (typeof LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<Language, string> = {
  'arduino-cpp': 'Arduino C++',
  micropython: 'MicroPython',
};

/** Capabilities a GPIO can provide to a connected component. */
export type PinCapability =
  | 'digital-in'
  | 'digital-out'
  | 'adc'
  | 'dac'
  | 'pwm'
  | 'touch'
  | 'i2c'
  | 'spi'
  | 'uart'
  | 'interrupt';

/**
 * Board-level pin restrictions. Validation rules interpret these flags; no rule
 * contains board-specific logic.
 */
export type PinFlag =
  /** Pin cannot drive output (e.g. ESP32 GPIO34-39). */
  | 'input-only'
  /** Sampled at reset to select boot mode; external pulls can break booting. */
  | 'strapping'
  /** Connected to on-module SPI flash; must never be used. */
  | 'flash'
  /** Connected to on-module PSRAM on common module variants. */
  | 'psram'
  /** Shared with the USB-serial bridge used for upload and Serial. */
  | 'usb-serial'
  /** Native USB D+/D- */
  | 'usb'
  /** ADC2 channel; unavailable while Wi-Fi is active (ESP32 family). */
  | 'adc2-wifi'
  /** No internal pull-up/pull-down resistors. */
  | 'no-pullup'
  /** Analog input only, cannot be used as digital IO (e.g. Nano A6/A7). */
  | 'analog-only'
  /** Drives an on-board LED. */
  | 'onboard-led'
  /** Not routed to a header (internal pin). */
  | 'internal';

export interface BoardPin {
  /** Canonical id used in circuits, e.g. "GPIO25", "D13", "A0", "GP15". */
  id: string;
  /** Silkscreen label. */
  label: string;
  /** Alternative spellings accepted when resolving AI output or user input. */
  aliases?: string[];
  /** Numeric pin identifier used by firmware (Arduino pin number / GPIO number). */
  gpio: number;
  /** Preferred symbol for Arduino code when it differs from the number (e.g. "A0"). */
  arduinoSymbol?: string;
  capabilities: PinCapability[];
  adc?: { unit: number; channel: number };
  dac?: { channel: number };
  touch?: number;
  flags?: PinFlag[];
  notes?: string;
}

export interface PowerPin {
  id: string;
  label: string;
  kind: 'power' | 'ground' | 'control';
  /** Nominal voltage for power pins. */
  voltage?: number;
  /** Approximate current budget available from this rail, when documented. */
  maxCurrentMa?: number;
  notes?: string;
}

export type BusKind = 'i2c' | 'spi' | 'uart';

export interface BusDefinition {
  kind: BusKind;
  id: string;
  /** Signal name -> board pin id. i2c: sda/scl; spi: mosi/miso/sck/cs; uart: tx/rx */
  pins: Record<string, string>;
  isDefault?: boolean;
  notes?: string;
}

export type SupportLevel = 'supported' | 'untested' | 'unsupported';

export interface BoardDefinition {
  id: string;
  name: string;
  vendor: string;
  /** Architecture family; used for library compatibility and simulation selection. */
  architecture: 'esp32' | 'esp32s3' | 'esp32c3' | 'avr' | 'renesas_uno' | 'rp2040';
  mcu: string;
  clockMhz: number;
  flashKb?: number;
  sramKb?: number;
  /** IO voltage. */
  logicVoltage: number;
  fiveVoltTolerant: boolean;
  /** Recommended max continuous current per GPIO. */
  maxPinCurrentMa?: number;
  /**
   * 'fixed' means peripheral buses only exist on the pins listed in `buses`.
   * 'flexible' means a GPIO matrix can route I2C/SPI/UART to most pins.
   */
  pinMux: 'fixed' | 'flexible';
  wifi: boolean;
  bluetooth: boolean;
  pins: BoardPin[];
  power: PowerPin[];
  buses: BusDefinition[];
  /** Physical header order for rendering (pin ids, top to bottom). */
  headers: { left: string[]; right: string[] };
  languages: Language[];
  toolchain: {
    arduino?: {
      fqbn: string;
      /** Board package (core) id, e.g. "esp32:esp32". */
      core: string;
      /** Additional Boards Manager URL required to install the core, if not built-in. */
      indexUrl?: string;
    };
    micropython?: {
      /** How MicroPython firmware is put on the board. */
      firmwareFlash: 'esptool' | 'uf2';
      /** Official download page for firmware images. */
      firmwareUrl: string;
      /** esptool chip id when firmwareFlash = esptool. */
      esptoolChip?: string;
      /** Flash offset for the firmware image. */
      flashOffset?: string;
    };
  };
  /** Known USB VID/PID pairs that identify this board specifically or plausibly. */
  usbIds: { vid: string; pid: string; confidence: 'exact' | 'likely' | 'possible'; note?: string }[];
  simulation: {
    /** MCU emulator backend that can execute compiled firmware, or null for circuit-only. */
    mcuEmulator: 'avr8js-atmega328p' | null;
  };
  support: { build: SupportLevel; flash: SupportLevel; simulate: SupportLevel };
  /** Datasheets / pinout references used to author this definition. */
  references: string[];
}

/* ------------------------------------------------------------------ */
/* Components                                                          */
/* ------------------------------------------------------------------ */

export type ComponentCategory =
  | 'basic'
  | 'input'
  | 'sensor'
  | 'display'
  | 'actuator'
  | 'communication'
  | 'layout';

export type ComponentPinRole = 'power' | 'ground' | 'signal' | 'bus' | 'passive';

export interface ComponentPin {
  id: string;
  label: string;
  role: ComponentPinRole;
  /**
   * Board capabilities required when this pin is connected (directly or through a
   * passive series component) to a board GPIO.
   */
  requires?: PinCapability[];
  /** For role 'bus'. */
  bus?: { kind: BusKind; signal: string };
  /** The component needs this pin connected to function. */
  required?: boolean;
  /**
   * Signal pins that output a voltage: 'supply' means the high level equals the
   * component supply voltage (e.g. HC-SR04 ECHO powered from 5 V outputs 5 V).
   */
  outputHigh?: 'supply' | number;
  /** Highest voltage this input tolerates, if lower than supply max. */
  inputMaxV?: number;
  description?: string;
}

export type PropType = 'number' | 'string' | 'enum' | 'boolean';

export interface PropDefinition {
  key: string;
  label: string;
  type: PropType;
  default: number | string | boolean;
  unit?: string;
  options?: (string | number)[];
  min?: number;
  max?: number;
  /** Property is a simulation stimulus (e.g. temperature) rather than a hardware attribute. */
  simulation?: boolean;
  description?: string;
}

export interface LibraryRequirement {
  name: string;
  version?: string;
  /** Restrict to architectures; omitted = all. */
  architectures?: BoardDefinition['architecture'][];
  /** Headers this library provides, used to map "missing header" errors to libraries. */
  headers?: string[];
  /** Library ships with the core (no install needed). */
  bundled?: boolean;
}

export type SimModelId =
  | 'led'
  | 'resistor'
  | 'button'
  | 'potentiometer'
  | 'analog-sensor'
  | 'buzzer'
  | 'servo'
  | 'relay'
  | 'digital-sensor'
  | 'none';

export interface ComponentDefinition {
  type: string;
  name: string;
  category: ComponentCategory;
  description: string;
  /** Default instance label prefix, e.g. "led" -> led1, led2. */
  labelPrefix: string;
  pins: ComponentPin[];
  props: PropDefinition[];
  power?: {
    minV: number;
    maxV: number;
    typicalMa?: number;
    peakMa?: number;
  };
  /** I2C address property key for bus address conflict checks. */
  i2cAddressProp?: string;
  firmware: {
    arduino?: { libraries: LibraryRequirement[] };
    micropython?: { modules: string[]; mip?: string[]; notes?: string };
    /** Pins that get a firmware #define/constant, with the symbol suffix. */
    symbols: { pin: string; suffix: string }[];
  };
  sim: {
    model: SimModelId;
    notes?: string;
    /** Property that drives the simulated output (e.g. "moisture", "position", "motion"). */
    stimulus?: string;
    /** Analog output voltage range [at stimulus min, at stimulus max]; 'supply' scales with supply. */
    outputRange?: [number, number] | 'supply';
    /** Output pin driven by the model. */
    outputPin?: string;
  };
  /** Rendering hints for the circuit canvas. */
  visual: { shape: 'led' | 'resistor' | 'button' | 'module' | 'breadboard'; width: number; height: number; color?: string };
  /** Purely visual layout aids carry no electrical meaning. */
  electrical: boolean;
  references?: string[];
}
