/**
 * Streaming byte -> line assembler for serial data. Handles UTF-8 sequences split
 * across chunks, CR, LF and CRLF line endings, and caps runaway lines.
 */

export interface SerialLine {
  /** Monotonic sequence number (per assembler). */
  seq: number;
  /** Epoch milliseconds when the line completed. */
  t: number;
  text: string;
}

export const LINE_ENDINGS = { none: '', lf: '\n', cr: '\r', crlf: '\r\n' } as const;
export type LineEnding = keyof typeof LINE_ENDINGS;

export class LineAssembler {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private partial = '';
  private lastWasCR = false;
  private seq = 0;

  constructor(
    private readonly maxLineLength = 4096,
    private readonly now: () => number = Date.now,
  ) {}

  push(chunk: Uint8Array): SerialLine[] {
    const text = this.decoder.decode(chunk, { stream: true });
    return this.consume(text);
  }

  private consume(text: string): SerialLine[] {
    const out: SerialLine[] = [];
    for (const ch of text) {
      if (ch === '\n') {
        if (this.lastWasCR) {
          this.lastWasCR = false;
          continue;
        }
        out.push(this.emit());
      } else if (ch === '\r') {
        out.push(this.emit());
        this.lastWasCR = true;
      } else {
        this.lastWasCR = false;
        this.partial += ch;
        if (this.partial.length >= this.maxLineLength) out.push(this.emit());
      }
    }
    return out;
  }

  /** Returns the unterminated tail (e.g. a prompt like ">>> "), without consuming it. */
  peekPartial(): string {
    return this.partial;
  }

  /** Emits any buffered partial line. */
  flush(): SerialLine[] {
    const tail = this.decoder.decode();
    const out = this.consume(tail);
    if (this.partial.length > 0) out.push(this.emit());
    return out;
  }

  private emit(): SerialLine {
    const line: SerialLine = { seq: ++this.seq, t: this.now(), text: this.partial };
    this.partial = '';
    return line;
  }
}

/** Bounded line buffer (ring) used to keep recent serial history for UI and AI context. */
export class LineRing {
  private buf: SerialLine[] = [];
  constructor(readonly capacity: number) {}
  push(lines: SerialLine[]): void {
    this.buf.push(...lines);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
  }
  tail(n: number): SerialLine[] {
    return this.buf.slice(-n);
  }
  all(): SerialLine[] {
    return [...this.buf];
  }
  clear(): void {
    this.buf = [];
  }
  get size(): number {
    return this.buf.length;
  }
}
