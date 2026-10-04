import { access, constants } from 'node:fs/promises';
import type { BoardCandidate, Device, DeviceDiagnosis, UsbDeviceReport } from '../../core/ipc/contract';
import { getRegistry } from '../../core/registry/registry';
import { identifyUsbChip, normalizeHex } from '../../core/registry/usbChips';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../logging/logger';
import type { ProcessRunner } from '../process/runner';

export interface PortInfo {
  path: string;
  manufacturer?: string | undefined;
  serialNumber?: string | undefined;
  vendorId?: string | undefined;
  productId?: string | undefined;
  pnpId?: string | undefined;
}

/** OS adapter for serial port enumeration (serialport bindings in production, fakes in tests). */
export interface PortLister {
  list(): Promise<PortInfo[]>;
}

/** Ports that are never development boards. */
const IGNORE_PORT = /(Bluetooth|debug-console|wlan-debug|AirPods|Incoming-Port|Sound|Headphones|^\/dev\/tty\.)/i;
const USB_PORT = /(usbserial|usbmodem|wchusbserial|SLAB_USBtoUART|ttyUSB|ttyACM|^COM\d+$)/i;

export function isRelevantPort(p: PortInfo): boolean {
  if (IGNORE_PORT.test(p.path)) return false;
  return Boolean(p.vendorId) || USB_PORT.test(p.path);
}

export function boardCandidates(vid: string | null, pid: string | null): BoardCandidate[] {
  if (!vid) return [];
  const out: BoardCandidate[] = [];
  for (const b of getRegistry().listBoards()) {
    for (const id of b.usbIds) {
      if (id.vid === vid && id.pid === pid) out.push({ boardId: b.id, confidence: id.confidence, ...(id.note ? { note: id.note } : {}) });
    }
  }
  const rank = { exact: 0, likely: 1, possible: 2 };
  return out.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
}

const DISCONNECTED_RETENTION_MS = 60_000;

/**
 * Tracks serial devices: enumeration, hot-plug detection by polling, VID/PID
 * identification and per-device state (CONNECTED / DISCONNECTED / PORT_BUSY /
 * DRIVER_MISSING / UNKNOWN).
 */
export class DeviceManager {
  private devices = new Map<string, Device>();
  private busy = new Set<string>();
  private inUse = new Set<string>();
  private driverMissing: UsbDeviceReport[] = [];
  private timer: NodeJS.Timeout | null = null;
  private scanning: Promise<Device[]> | null = null;

  constructor(
    private readonly lister: PortLister,
    private readonly bus: EventBus,
    private readonly log: ScopedLogger,
    private readonly runner?: ProcessRunner,
    private readonly now: () => number = Date.now,
  ) {}

  start(intervalMs = 1500): void {
    this.stop();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(): Device[] {
    const out = [...this.devices.values()];
    for (const r of this.driverMissing) {
      out.push({
        id: `usb:${r.vid}:${r.pid}:${r.serialNumber ?? ''}`,
        port: '',
        state: 'DRIVER_MISSING',
        vid: r.vid,
        pid: r.pid,
        serialNumber: r.serialNumber,
        manufacturer: r.manufacturer,
        product: r.name,
        usbChip: { family: r.family, chip: r.chip },
        candidates: boardCandidates(r.vid, r.pid),
        inUse: false,
        firstSeen: new Date(this.now()).toISOString(),
        lastSeen: new Date(this.now()).toISOString(),
      });
    }
    return out.sort((a, b) => a.port.localeCompare(b.port));
  }

  get(port: string): Device | undefined {
    return this.devices.get(port);
  }

  /** Enumerate ports now and emit changes. Concurrent calls share one scan. */
  refresh(): Promise<Device[]> {
    this.scanning ??= this.scan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async scan(): Promise<Device[]> {
    let ports: PortInfo[];
    try {
      ports = (await this.lister.list()).filter(isRelevantPort);
    } catch (err) {
      this.log.error('serial port enumeration failed', { error: err });
      return this.list();
    }
    const nowIso = new Date(this.now()).toISOString();
    let changed = false;
    const present = new Set(ports.map((p) => p.path));
    for (const p of ports) {
      const vid = normalizeHex(p.vendorId);
      const pid = normalizeHex(p.productId);
      const prev = this.devices.get(p.path);
      const state = this.busy.has(p.path) ? 'PORT_BUSY' : vid || USB_PORT.test(p.path) ? 'CONNECTED' : 'UNKNOWN';
      const next: Device = {
        id: p.path,
        port: p.path,
        state,
        vid,
        pid,
        serialNumber: p.serialNumber ?? null,
        manufacturer: p.manufacturer ?? null,
        product: null,
        usbChip: identifyUsbChip(vid, pid),
        candidates: boardCandidates(vid, pid),
        inUse: this.inUse.has(p.path),
        firstSeen: prev && prev.state !== 'DISCONNECTED' ? prev.firstSeen : nowIso,
        lastSeen: nowIso,
      };
      if (!prev || prev.state !== next.state || prev.vid !== next.vid || prev.pid !== next.pid || prev.inUse !== next.inUse) {
        changed = true;
        if (!prev || prev.state === 'DISCONNECTED') this.log.info('device connected', { port: p.path, vid, pid });
      }
      this.devices.set(p.path, next);
    }
    for (const [port, d] of this.devices) {
      if (present.has(port)) continue;
      if (d.state !== 'DISCONNECTED') {
        this.devices.set(port, { ...d, state: 'DISCONNECTED', inUse: false });
        this.log.info('device disconnected', { port });
        changed = true;
      } else if (this.now() - Date.parse(d.lastSeen) > DISCONNECTED_RETENTION_MS) {
        this.devices.delete(port);
        changed = true;
      }
    }
    // A driver-missing USB device that now has a port is resolved.
    const before = this.driverMissing.length;
    this.driverMissing = this.driverMissing.filter((r) => !ports.some((p) => normalizeHex(p.vendorId) === r.vid && normalizeHex(p.productId) === r.pid));
    if (before !== this.driverMissing.length) changed = true;
    const list = this.list();
    if (changed) this.bus.emit('devices.changed', list);
    return list;
  }

  markBusy(port: string, busy: boolean): void {
    if (busy) this.busy.add(port);
    else this.busy.delete(port);
    void this.refresh();
  }

  setInUse(port: string, inUse: boolean): void {
    if (inUse) this.inUse.add(port);
    else this.inUse.delete(port);
    const d = this.devices.get(port);
    if (d) {
      this.devices.set(port, { ...d, inUse });
      this.bus.emit('devices.changed', this.list());
    }
  }

  /** Called with driver-hub results: USB bridges present without a serial port. */
  setDriverFindings(reports: UsbDeviceReport[]): void {
    this.driverMissing = reports.filter((r) => r.driverState === 'missing');
    this.bus.emit('devices.changed', this.list());
  }

  async diagnose(port: string): Promise<DeviceDiagnosis> {
    await this.refresh();
    const device = this.devices.get(port) ?? null;
    const findings: DeviceDiagnosis['findings'] = [];
    let holders: string[] = [];
    if (!device || device.state === 'DISCONNECTED') {
      findings.push({ level: 'error', message: `${port} is not present. Check the USB cable (it must carry data, not only power) and reconnect the board.` });
      return { port, device, findings, holders };
    }
    findings.push({ level: 'ok', message: `Port ${port} is present.` });
    if (device.vid) {
      findings.push({ level: 'info', message: `USB ${device.vid}:${device.pid}${device.usbChip.chip ? ` — ${device.usbChip.chip}` : ''}${device.manufacturer ? ` (${device.manufacturer})` : ''}` });
    } else findings.push({ level: 'warning', message: 'The OS did not report USB vendor/product IDs for this port.' });
    if (device.candidates.length) {
      findings.push({ level: 'info', message: `Possible boards: ${device.candidates.map((c) => `${getRegistry().getBoard(c.boardId)?.name ?? c.boardId} (${c.confidence})`).join(', ')}` });
    } else findings.push({ level: 'info', message: 'The board type cannot be determined from USB IDs alone.' });
    try {
      await access(port, constants.R_OK | constants.W_OK);
      findings.push({ level: 'ok', message: 'Read/write permission on the port.' });
    } catch {
      findings.push({
        level: 'error',
        message:
          process.platform === 'linux'
            ? 'No permission to open the port. Add your user to the "dialout" (or "uucp") group and log out/in.'
            : 'No permission to open the port.',
      });
    }
    if (this.runner && (process.platform === 'darwin' || process.platform === 'linux') && this.runner.isAvailable('lsof')) {
      try {
        const r = await this.runner.run({ tool: 'lsof', args: ['-F', 'pc', port], timeoutMs: 10_000, purpose: `Find processes using ${port}`, quiet: true });
        holders = parseLsof(r.stdout);
      } catch (err) {
        this.log.warn('lsof failed', { error: err });
      }
    }
    if (holders.length) findings.push({ level: device.inUse ? 'info' : 'warning', message: `Port is open by: ${holders.join(', ')}${device.inUse ? ' (the IoT-OS Serial Monitor)' : ''}. Close it before uploading.` });
    else findings.push({ level: 'ok', message: 'No process currently holds the port.' });
    return { port, device, findings, holders };
  }
}

/** Parses `lsof -F pc` output into "command (pid)" strings. */
export function parseLsof(out: string): string[] {
  const holders: string[] = [];
  let pid: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    else if (line.startsWith('c') && pid) holders.push(`${line.slice(1)} (${pid})`);
  }
  return [...new Set(holders)];
}
