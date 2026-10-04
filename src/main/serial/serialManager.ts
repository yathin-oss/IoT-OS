import { SerialPortStream } from '@serialport/stream';
import { IotosError } from '../../core/errors';
import type { SerialOpenOptions, SerialStatus } from '../../core/ipc/contract';
import { LINE_ENDINGS, LineAssembler, LineRing, type LineEnding, type SerialLine } from '../../core/serial/lines';
import type { DeviceManager } from '../devices/deviceManager';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../logging/logger';

/** Serial binding (OS bindings in production, MockBinding in tests). */
export type SerialBinding = ConstructorParameters<typeof SerialPortStream>[0]['binding'];

const FLUSH_MS = 50;
const MAX_PENDING_LINES = 5000;

/**
 * Serial port I/O for the Serial Monitor, Plotter and AI context.
 *  - Data is decoded and split into lines in the main process.
 *  - Lines are batched to the UI every 50 ms, so high baud rates do not flood IPC.
 *  - If the UI falls behind, the oldest pending lines are dropped with a visible marker.
 *  - A bounded ring keeps recent history for the AI context and reopened panels.
 */
export class SerialManager {
  private port: SerialPortStream | null = null;
  private opts: SerialOpenOptions | null = null;
  private assembler = new LineAssembler();
  private pending: SerialLine[] = [];
  private dropped = 0;
  private timer: NodeJS.Timeout | null = null;
  private bytesIn = 0;
  private bytesOut = 0;
  private error: string | null = null;
  private reconnectTarget: SerialOpenOptions | null = null;
  private closingIntentionally = false;
  readonly history: LineRing;

  constructor(
    private readonly binding: SerialBinding,
    private readonly bus: EventBus,
    private readonly devices: DeviceManager,
    private readonly log: ScopedLogger,
    maxLines = 20000,
  ) {
    this.history = new LineRing(maxLines);
    bus.on('devices.changed', (list) => {
      const t = this.reconnectTarget;
      if (!t || this.port) return;
      if (list.some((d) => d.port === t.port && d.state === 'CONNECTED')) {
        this.log.info('device reappeared; reconnecting', { port: t.port });
        void this.open(t).catch((err) => this.log.warn('auto-reconnect failed', { error: err }));
      }
    });
  }

  status(): SerialStatus {
    return {
      open: this.port?.isOpen ?? false,
      port: this.opts?.port ?? null,
      baud: this.opts?.baud ?? null,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      linesBuffered: this.history.size,
      error: this.error,
    };
  }

  private emitStatus(): void {
    this.bus.emit('serial.status', this.status());
  }

  async open(opts: SerialOpenOptions): Promise<SerialStatus> {
    if (!opts.port || opts.port.includes('\0')) throw new IotosError('INVALID_ARGUMENT', 'Invalid port');
    if (!Number.isInteger(opts.baud) || opts.baud < 50 || opts.baud > 4_000_000) throw new IotosError('INVALID_ARGUMENT', `Invalid baud rate ${opts.baud}`);
    if (this.port) await this.close();
    this.assembler = new LineAssembler();
    this.error = null;
    const port = new SerialPortStream({
      binding: this.binding,
      path: opts.port,
      baudRate: opts.baud,
      dataBits: opts.dataBits ?? 8,
      stopBits: opts.stopBits ?? 1,
      parity: opts.parity ?? 'none',
      autoOpen: false,
    });
    await new Promise<void>((resolve, reject) => {
      port.open((err) => {
        if (!err) return resolve();
        const msg = err.message;
        if (/busy|lock|EBUSY|Access denied/i.test(msg)) {
          this.devices.markBusy(opts.port, true);
          reject(new IotosError('DEVICE_BUSY', `${opts.port} is in use by another program`, { hint: 'Close other serial monitors (Arduino IDE, screen, PlatformIO) and retry. Devices → Diagnose shows which process holds it.' }));
        } else if (/EACCES|permission/i.test(msg)) {
          reject(new IotosError('SERIAL_OPEN_FAILED', `Permission denied opening ${opts.port}`, { hint: process.platform === 'linux' ? 'Add your user to the dialout group and log in again.' : undefined }));
        } else if (/ENOENT|No such file|cannot find|File not found|does not exist|not found/i.test(msg)) {
          reject(new IotosError('DEVICE_NOT_FOUND', `${opts.port} does not exist`, { hint: 'Reconnect the board and refresh the device list.' }));
        } else reject(new IotosError('SERIAL_OPEN_FAILED', `Cannot open ${opts.port}: ${msg}`));
      });
    });
    this.port = port;
    this.opts = opts;
    this.reconnectTarget = opts.autoReconnect ? opts : null;
    this.devices.markBusy(opts.port, false);
    this.devices.setInUse(opts.port, true);
    port.on('data', (chunk: Buffer) => this.onData(chunk));
    port.on('error', (err: Error) => {
      this.error = err.message;
      this.log.warn('serial error', { port: opts.port, error: err });
      this.emitStatus();
    });
    port.on('close', (err?: Error & { disconnected?: boolean }) => this.onClose(err));
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.log.info('serial opened', { port: opts.port, baud: opts.baud });
    this.emitStatus();
    return this.status();
  }

  private onData(chunk: Buffer): void {
    this.bytesIn += chunk.length;
    const lines = this.assembler.push(chunk);
    if (lines.length === 0) return;
    this.history.push(lines);
    this.pending.push(...lines);
    if (this.pending.length > MAX_PENDING_LINES) {
      const drop = this.pending.length - MAX_PENDING_LINES;
      this.pending.splice(0, drop);
      this.dropped += drop;
    }
  }

  private flush(): void {
    const partial = this.assembler.peekPartial();
    if (this.pending.length === 0 && this.dropped === 0 && !partial) return;
    const lines = this.pending;
    this.pending = [];
    if (this.dropped > 0) {
      lines.unshift({ seq: -1, t: Date.now(), text: `[IoT-OS: ${this.dropped} lines dropped from the live view; full history is kept for export]` });
      this.dropped = 0;
    }
    this.bus.emit('serial.data', { lines, partial });
  }

  private onClose(err?: Error & { disconnected?: boolean }): void {
    const port = this.opts?.port;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const tail = this.assembler.flush();
    if (tail.length) {
      this.history.push(tail);
      this.pending.push(...tail);
    }
    this.flush();
    this.port = null;
    if (port) this.devices.setInUse(port, false);
    if (!this.closingIntentionally) {
      this.error = err?.disconnected ? 'Device disconnected' : (err?.message ?? 'Port closed unexpectedly');
      this.log.warn('serial port closed unexpectedly', { port, error: this.error });
    }
    this.closingIntentionally = false;
    this.emitStatus();
  }

  async close(): Promise<SerialStatus> {
    const port = this.port;
    this.reconnectTarget = null;
    if (!port) return this.status();
    this.closingIntentionally = true;
    await new Promise<void>((resolve) => {
      if (!port.isOpen) return resolve();
      port.close(() => resolve());
    });
    // 'close' handler cleans up; ensure state even if the binding never emitted it.
    if (this.port === port) this.onClose();
    this.log.info('serial closed', { port: this.opts?.port });
    return this.status();
  }

  async write(data: string, lineEnding: LineEnding): Promise<void> {
    const port = this.port;
    if (!port?.isOpen) throw new IotosError('SERIAL_NOT_OPEN', 'The serial port is not open');
    const buf = Buffer.from(data + LINE_ENDINGS[lineEnding], 'utf8');
    await new Promise<void>((resolve, reject) => {
      port.write(buf, (err) => (err ? reject(new IotosError('SERIAL_WRITE_FAILED', `Write failed: ${err.message}`)) : port.drain((e) => (e ? reject(e) : resolve()))));
    });
    this.bytesOut += buf.length;
  }

  clearHistory(): void {
    this.history.clear();
  }

  /**
   * Temporarily release a port (e.g. for flashing). Returns a function that
   * reopens it with the previous options.
   */
  async releaseFor(port: string): Promise<(() => Promise<void>) | null> {
    if (!this.port || this.opts?.port !== port) return null;
    const prev = this.opts;
    const reconnect = this.reconnectTarget;
    await this.close();
    return async () => {
      await this.open(prev);
      this.reconnectTarget = reconnect;
    };
  }

  get currentPort(): string | null {
    return this.port ? (this.opts?.port ?? null) : null;
  }
}
