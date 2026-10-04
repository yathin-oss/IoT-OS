/**
 * Serial Plotter telemetry parser.
 *
 * Supported formats (documented in docs/SERIAL.md):
 *   1. Positional numbers separated by comma, space or tab:   25.4,61.2,723
 *   2. Labelled pairs (Arduino IDE 2 style):                  temp:25.4 hum:61.2   or   temp=25.4,hum=61.2
 *   3. A header line of names followed by positional rows:    temperature,humidity,soil
 * Lines that contain no numbers (log messages) are ignored.
 */

export interface TelemetrySample {
  /** series name -> value */
  values: Record<string, number>;
}

const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const SPLIT = /[,\t;]+|\s+/;

export class TelemetryParser {
  private header: string[] | null = null;

  reset(): void {
    this.header = null;
  }

  get columns(): string[] | null {
    return this.header;
  }

  parse(line: string): TelemetrySample | null {
    const text = line.trim();
    if (!text) return null;

    // Labelled pairs
    if (/[A-Za-z_][\w .-]*\s*[:=]\s*[-+.\d]/.test(text)) {
      const values: Record<string, number> = {};
      const re = /([A-Za-z_][\w.-]*)\s*[:=]\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
      for (let m = re.exec(text); m; m = re.exec(text)) values[m[1]!] = Number(m[2]);
      return Object.keys(values).length > 0 ? { values } : null;
    }

    const tokens = text.split(SPLIT).filter(Boolean);
    if (tokens.length === 0) return null;
    const allNumeric = tokens.every((t) => NUM.test(t));
    if (!allNumeric) {
      // Header line: comma/tab/semicolon separated identifiers (space-separated words are log text).
      const fields = text.split(/[,\t;]/).map((t) => t.trim());
      if (fields.length >= 2 && fields.length <= 16 && fields.every((t) => /^[A-Za-z_][\w.-]*$/.test(t))) {
        this.header = fields;
      }
      return null;
    }
    const values: Record<string, number> = {};
    tokens.forEach((t, i) => {
      const name = this.header && this.header.length === tokens.length ? this.header[i]! : `value${i + 1}`;
      values[name] = Number(t);
    });
    return { values };
  }
}

/** Fixed-capacity ring buffer of numeric series for plotting. */
export class SeriesBuffer {
  readonly capacity: number;
  private readonly series = new Map<string, Float64Array>();
  private readonly times: Float64Array;
  private head = 0;
  private count = 0;

  constructor(capacity = 2000) {
    this.capacity = capacity;
    this.times = new Float64Array(capacity);
  }

  push(t: number, sample: TelemetrySample): void {
    for (const name of Object.keys(sample.values)) {
      if (!this.series.has(name)) this.series.set(name, new Float64Array(this.capacity).fill(Number.NaN));
    }
    for (const [name, arr] of this.series) arr[this.head] = sample.values[name] ?? Number.NaN;
    this.times[this.head] = t;
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  clear(): void {
    this.series.clear();
    this.head = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  names(): string[] {
    return [...this.series.keys()];
  }

  /** Returns samples oldest-first. */
  snapshot(): { t: number[]; series: Record<string, number[]> } {
    const start = (this.head - this.count + this.capacity) % this.capacity;
    const t: number[] = [];
    const series: Record<string, number[]> = {};
    for (const name of this.series.keys()) series[name] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      t.push(this.times[idx]!);
      for (const [name, arr] of this.series) series[name]!.push(arr[idx]!);
    }
    return { t, series };
  }
}
