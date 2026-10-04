import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DriverScan, UsbDeviceReport } from '../../core/ipc/contract';
import { DRIVERS, identifyUsbChip, normalizeHex, type UsbChipFamily } from '../../core/registry/usbChips';
import type { PortInfo, PortLister } from '../devices/deviceManager';
import type { ScopedLogger } from '../logging/logger';
import type { ProcessRunner } from '../process/runner';

export interface RawUsbDevice {
  name: string;
  vid: string | null;
  pid: string | null;
  manufacturer: string | null;
  serialNumber: string | null;
  /** Ports the OS adapter itself associated with the device (Linux/Windows). */
  ports?: string[];
  /** Windows: PnP problem status. */
  problem?: boolean;
}

/** OS-specific USB enumeration. */
export interface UsbEnumerator {
  readonly method: string;
  list(): Promise<RawUsbDevice[]>;
}

/* ------------------------------- macOS ------------------------------- */

type ProfilerNode = Record<string, unknown> & { _items?: ProfilerNode[]; _name?: string };

/** Parses both the legacy SPUSBDataType and the macOS 26+ SPUSBHostDataType JSON. */
export function parseSystemProfiler(json: unknown): RawUsbDevice[] {
  const out: RawUsbDevice[] = [];
  const root = json as Record<string, ProfilerNode[]>;
  const top = root['SPUSBHostDataType'] ?? root['SPUSBDataType'] ?? [];
  const visit = (n: ProfilerNode) => {
    const vidRaw = (n['USBDeviceKeyVendorID'] ?? n['vendor_id']) as string | undefined;
    const pidRaw = (n['USBDeviceKeyProductID'] ?? n['product_id']) as string | undefined;
    if (vidRaw) {
      const vid = normalizeHex(vidRaw.split(/\s/)[0]);
      const pid = normalizeHex(pidRaw?.split(/\s/)[0]);
      const serial = (n['USBDeviceKeySerialNumber'] ?? n['serial_num']) as string | undefined;
      const manuf = (n['USBDeviceKeyVendorName'] ?? n['manufacturer']) as string | undefined;
      out.push({ name: n._name ?? 'USB device', vid, pid, manufacturer: manuf ?? null, serialNumber: serial && serial !== 'Not Provided' ? serial : null });
    }
    for (const c of n._items ?? []) visit(c);
  };
  for (const n of top) visit(n);
  return out;
}

export class MacUsbEnumerator implements UsbEnumerator {
  readonly method = 'system_profiler';
  constructor(private readonly runner: ProcessRunner) {}
  async list(): Promise<RawUsbDevice[]> {
    for (const type of ['SPUSBHostDataType', 'SPUSBDataType']) {
      const r = await this.runner.run({ tool: 'system_profiler', args: [type, '-json'], timeoutMs: 30_000, purpose: 'Enumerate USB devices', quiet: true });
      if (r.exitCode !== 0 || !r.stdout.trim()) continue;
      try {
        const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
        if (parsed[type]) return parseSystemProfiler(parsed);
      } catch {
        continue;
      }
    }
    return [];
  }
}

/* -------------------------------- Linux ------------------------------ */

export class LinuxUsbEnumerator implements UsbEnumerator {
  readonly method = 'sysfs';
  constructor(private readonly base = '/sys/bus/usb/devices') {}
  private async read(dir: string, file: string): Promise<string | null> {
    try {
      return (await readFile(join(dir, file), 'utf8')).trim() || null;
    } catch {
      return null;
    }
  }
  async list(): Promise<RawUsbDevice[]> {
    const out: RawUsbDevice[] = [];
    for (const entry of await readdir(this.base).catch(() => [] as string[])) {
      if (entry.includes(':')) continue; // interfaces
      const dir = join(this.base, entry);
      const vid = normalizeHex(await this.read(dir, 'idVendor'));
      if (!vid) continue;
      const ports: string[] = [];
      for (const sub of await readdir(dir).catch(() => [] as string[])) {
        if (!sub.startsWith(`${entry}:`)) continue;
        for (const t of await readdir(join(dir, sub)).catch(() => [] as string[])) {
          if (/^tty(USB|ACM)\d+$/.test(t)) ports.push(`/dev/${t}`);
          if (t === 'tty') for (const tt of await readdir(join(dir, sub, 'tty')).catch(() => [] as string[])) ports.push(`/dev/${tt}`);
        }
      }
      out.push({
        name: (await this.read(dir, 'product')) ?? 'USB device',
        vid,
        pid: normalizeHex(await this.read(dir, 'idProduct')),
        manufacturer: await this.read(dir, 'manufacturer'),
        serialNumber: await this.read(dir, 'serial'),
        ports,
      });
    }
    return out;
  }
}

/* ------------------------------- Windows ----------------------------- */

/** Fixed script (no interpolation) listing present USB PnP devices as JSON. */
const WINDOWS_PNP_SCRIPT =
  "Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USB\\VID_*' } | Select-Object FriendlyName,InstanceId,Status,Class,Manufacturer | ConvertTo-Json -Compress";

export function parseWindowsPnp(json: unknown): RawUsbDevice[] {
  const list = Array.isArray(json) ? json : json ? [json] : [];
  return list.map((d) => {
    const o = d as Record<string, string | null>;
    const id = o['InstanceId'] ?? '';
    const m = /VID_([0-9A-F]{4})&PID_([0-9A-F]{4})(?:[^\\]*)\\?(.*)$/i.exec(id);
    const name = o['FriendlyName'] ?? 'USB device';
    const com = /\((COM\d+)\)/.exec(name);
    return {
      name,
      vid: normalizeHex(m?.[1]),
      pid: normalizeHex(m?.[2]),
      manufacturer: o['Manufacturer'] ?? null,
      serialNumber: m?.[3] && !m[3].includes('&') ? m[3] : null,
      ports: com ? [com[1]!] : [],
      problem: (o['Status'] ?? '').toLowerCase() === 'error' || !o['Class'],
    };
  });
}

export class WindowsUsbEnumerator implements UsbEnumerator {
  readonly method = 'Get-PnpDevice';
  constructor(private readonly runner: ProcessRunner) {}
  async list(): Promise<RawUsbDevice[]> {
    const r = await this.runner.run({ tool: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PNP_SCRIPT], timeoutMs: 30_000, purpose: 'Enumerate USB devices', quiet: true });
    if (r.exitCode !== 0 || !r.stdout.trim()) return [];
    return parseWindowsPnp(JSON.parse(r.stdout));
  }
}

/* ------------------------------ Driver hub ---------------------------- */

const SERIAL_FAMILIES: UsbChipFamily[] = ['ch34x', 'cp210x', 'ftdi', 'arduino-native', 'espressif-native', 'rp2040'];

/** Correlates USB devices with serial ports to determine driver state. */
export function buildDriverReports(usb: RawUsbDevice[], ports: PortInfo[], platform: 'darwin' | 'win32' | 'linux'): UsbDeviceReport[] {
  const out: UsbDeviceReport[] = [];
  for (const d of usb) {
    const { family, chip } = identifyUsbChip(d.vid, d.pid);
    if (!SERIAL_FAMILIES.includes(family)) continue;
    const matching = ports.filter((p) => normalizeHex(p.vendorId) === d.vid && normalizeHex(p.productId) === d.pid && (!d.serialNumber || !p.serialNumber || p.serialNumber === d.serialNumber)).map((p) => p.path);
    const serialPorts = [...new Set([...(d.ports ?? []), ...matching])];
    const info = DRIVERS[family];
    const osInfo = info.os[platform];
    const bootsel = family === 'rp2040' && d.pid === '0003';
    let driverState: UsbDeviceReport['driverState'];
    if (bootsel) driverState = 'not-required';
    else if (serialPorts.length > 0 && !d.problem) driverState = 'ok';
    else if (family === 'ch34x' || family === 'cp210x' || family === 'ftdi' || d.problem) driverState = 'missing';
    else driverState = 'unknown';
    out.push({
      name: d.name,
      vid: d.vid,
      pid: d.pid,
      manufacturer: d.manufacturer,
      serialNumber: d.serialNumber,
      family,
      chip,
      serialPorts,
      driverState,
      driver: {
        name: info.name,
        vendor: info.vendor,
        downloadUrl: info.downloadUrl,
        builtIn: osInfo.builtIn,
        guidance: bootsel ? 'Board is in BOOTSEL mode (USB drive). Copy a .uf2 file to flash it; no serial port is expected.' : osInfo.guidance,
      },
    });
  }
  return out;
}

export class DriverHub {
  constructor(
    private readonly enumerator: UsbEnumerator | null,
    private readonly ports: PortLister,
    private readonly log: ScopedLogger,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async scan(): Promise<DriverScan> {
    if (!this.enumerator || !['darwin', 'linux', 'win32'].includes(this.platform)) {
      return { supported: false, method: 'none', devices: [], message: `USB driver diagnostics are not available on ${this.platform}.` };
    }
    try {
      const [usb, ports] = await Promise.all([this.enumerator.list(), this.ports.list()]);
      const devices = buildDriverReports(usb, ports, this.platform as 'darwin' | 'linux' | 'win32');
      const missing = devices.filter((d) => d.driverState === 'missing').length;
      return {
        supported: true,
        method: this.enumerator.method,
        devices,
        message: devices.length === 0 ? 'No USB-serial development boards detected.' : missing ? `${missing} device(s) without a working serial driver.` : 'All detected boards have a serial port.',
      };
    } catch (err) {
      this.log.error('driver scan failed', { error: err });
      return { supported: true, method: this.enumerator.method, devices: [], message: `USB enumeration failed: ${(err as Error).message}` };
    }
  }
}
