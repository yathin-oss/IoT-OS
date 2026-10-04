import { describe, expect, it } from 'vitest';
import { parseAnsi, stripAnsi } from './ansi';
import { LineAssembler, LineRing } from './lines';
import { SeriesBuffer, TelemetryParser } from './telemetry';

const enc = (s: string) => new TextEncoder().encode(s);

describe('LineAssembler', () => {
  it('splits LF, CR and CRLF lines across chunks', () => {
    const a = new LineAssembler(4096, () => 1);
    expect(a.push(enc('hel')).map((l) => l.text)).toEqual([]);
    expect(a.push(enc('lo\r')).map((l) => l.text)).toEqual(['hello']);
    expect(a.push(enc('\nworld\nx\ry')).map((l) => l.text)).toEqual(['world', 'x']);
    expect(a.peekPartial()).toBe('y');
    expect(a.flush().map((l) => l.text)).toEqual(['y']);
  });

  it('decodes UTF-8 split across chunks', () => {
    const bytes = enc('temp 25°C\n');
    const a = new LineAssembler();
    const i = bytes.indexOf(0xc2) + 1; // split inside the two-byte "°"
    expect(a.push(bytes.slice(0, i))).toEqual([]);
    expect(a.push(bytes.slice(i))[0]!.text).toBe('temp 25°C');
  });

  it('caps runaway lines', () => {
    const a = new LineAssembler(8);
    expect(a.push(enc('0123456789')).map((l) => l.text)).toEqual(['01234567']);
  });

  it('handles high-throughput input', () => {
    const a = new LineAssembler();
    const chunk = enc('x'.repeat(60) + '\n');
    let n = 0;
    const start = performance.now();
    for (let i = 0; i < 20000; i++) n += a.push(chunk).length;
    expect(n).toBe(20000);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('LineRing keeps only the most recent lines', () => {
    const r = new LineRing(3);
    r.push([1, 2, 3, 4, 5].map((seq) => ({ seq, t: 0, text: String(seq) })));
    expect(r.all().map((l) => l.text)).toEqual(['3', '4', '5']);
    expect(r.tail(2).map((l) => l.text)).toEqual(['4', '5']);
  });
});

describe('ANSI', () => {
  it('parses SGR colors and strips others', () => {
    expect(parseAnsi('\u001b[1;31mERR\u001b[0m ok\u001b[2K')).toEqual([
      { text: 'ERR', bold: true, fg: 'red' },
      { text: ' ok' },
    ]);
    expect(stripAnsi('\u001b[32mgreen\u001b[0m')).toBe('green');
  });
});

describe('telemetry parser', () => {
  it('parses positional, labelled and headed formats', () => {
    const p = new TelemetryParser();
    expect(p.parse('25.4,61.2,723')).toEqual({ values: { value1: 25.4, value2: 61.2, value3: 723 } });
    expect(p.parse('temp:25.4 hum:61')).toEqual({ values: { temp: 25.4, hum: 61 } });
    expect(p.parse('a=1,b=-2.5e1')).toEqual({ values: { a: 1, b: -25 } });
    expect(p.parse('temperature,humidity,soil')).toBeNull();
    expect(p.columns).toEqual(['temperature', 'humidity', 'soil']);
    expect(p.parse('25.6\t60.9\t710')).toEqual({ values: { temperature: 25.6, humidity: 60.9, soil: 710 } });
    expect(p.parse('Connecting to WiFi...')).toBeNull();
    expect(p.parse('Hello world')).toBeNull();
    expect(p.columns).toEqual(['temperature', 'humidity', 'soil']);
  });

  it('SeriesBuffer keeps a bounded ordered window', () => {
    const b = new SeriesBuffer(3);
    for (let i = 0; i < 5; i++) b.push(i, { values: { a: i, ...(i === 4 ? { b: 9 } : {}) } });
    const s = b.snapshot();
    expect(s.t).toEqual([2, 3, 4]);
    expect(s.series['a']).toEqual([2, 3, 4]);
    expect(s.series['b']![2]).toBe(9);
  });
});
