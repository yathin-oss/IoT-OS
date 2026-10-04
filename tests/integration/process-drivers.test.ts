import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDriverReports, parseSystemProfiler, parseWindowsPnp } from '../../src/main/drivers/driverHub';
import { parseLsof } from '../../src/main/devices/deviceManager';
import { testServices } from './helpers';

const SLOW = fileURLToPath(new URL('../fixtures/slow-tool.mjs', import.meta.url));

describe('process runner', () => {
  let t: ReturnType<typeof testServices>;
  beforeEach(() => {
    t = testServices();
    t.services.settings.update({ toolPaths: { git: SLOW } });
  });
  afterEach(async () => {
    await t.dispose();
  });

  it('passes arguments verbatim without a shell', async () => {
    const evil = '$(touch /tmp/iotos-pwned); `id` ; rm -rf ~ | cat';
    const r = await t.services.runner.run({ tool: 'git', args: [evil, 'a b'], timeoutMs: 10_000, purpose: 'test' });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([evil, 'a b']);
    expect(r.record.status).toBe('succeeded');
    expect(t.services.runner.output(r.record.id)).toContain('touch');
  });

  it('reports exit codes', async () => {
    const r = await t.services.runner.run({ tool: 'git', args: ['--fail'], timeoutMs: 10_000, purpose: 'test' });
    expect(r.exitCode).toBe(3);
    expect(r.record.status).toBe('failed');
  });

  it('kills processes on timeout', async () => {
    const t0 = Date.now();
    await expect(t.services.runner.run({ tool: 'git', args: ['--sleep'], timeoutMs: 400, purpose: 'test' })).rejects.toMatchObject({ code: 'TOOL_TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(t.services.runner.list()[0]!.status).toBe('timed-out');
  });

  it('cancels processes', async () => {
    const ctrl = new AbortController();
    const p = t.services.runner.run({ tool: 'git', args: ['--sleep'], timeoutMs: 30_000, purpose: 'test', signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 200);
    await expect(p).rejects.toMatchObject({ code: 'TOOL_CANCELLED' });
  });

  it('refuses tools that are not installed, with an install hint', async () => {
    t.services.settings.update({ toolPaths: { mpremote: '/nonexistent/mpremote' } });
    t.services.resolver.clearCache();
    await expect(t.services.runner.run({ tool: 'mpremote', args: [], timeoutMs: 1000, purpose: 'x' })).rejects.toMatchObject({ code: 'TOOL_MISSING', hint: expect.stringMatching(/pip install mpremote/) });
  });

  it('does not pass AI keys to external tools', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-should-not-leak-0000';
    try {
      const r = await t.services.runner.run({ tool: 'git', args: ['--print-env'], timeoutMs: 10_000, purpose: 'test' });
      expect(r.stdout).toContain('KEY=unset');
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });

  it('rejects option-like values that could inject CLI flags', async () => {
    const { libSpec } = await import('../../src/main/toolchain/arduinoCli');
    const { assertNotOption } = await import('../../src/main/process/runner');
    expect(() => libSpec('--config-file=/tmp/evil.yaml')).toThrow(/Invalid library name/);
    expect(() => assertNotOption('-p', 'Port')).toThrow(/must not start/);
    expect(libSpec('DHT sensor library', '1.4.6')).toBe('DHT sensor library@1.4.6');
  });

  it('redacts secrets in streamed output and command lines', async () => {
    t.services.logger.registerSecret('sk-ant-supersecretvalue123');
    const r = await t.services.runner.run({ tool: 'git', args: ['sk-ant-supersecretvalue123'], timeoutMs: 10_000, purpose: 'test' });
    expect(r.record.command).not.toContain('supersecret');
    expect(t.services.runner.output(r.record.id)).not.toContain('supersecret');
  });
});

describe('driver diagnostics parsing', () => {
  it('parses macOS 26 SPUSBHostDataType and legacy SPUSBDataType JSON', () => {
    const modern = { SPUSBHostDataType: [{ _name: 'USB 3.1 Bus', _items: [{ _name: 'USB Serial', USBDeviceKeyVendorID: '0x1a86', USBDeviceKeyProductID: '0x7523', USBDeviceKeyVendorName: 'QinHeng', USBDeviceKeySerialNumber: 'Not Provided' }] }] };
    expect(parseSystemProfiler(modern)).toEqual([{ name: 'USB Serial', vid: '1A86', pid: '7523', manufacturer: 'QinHeng', serialNumber: null }]);
    const legacy = { SPUSBDataType: [{ _items: [{ _name: 'CP2102 USB to UART Bridge Controller', vendor_id: '0x10c4  (Silicon Laboratories, Inc.)', product_id: '0xea60', serial_num: '0001', manufacturer: 'Silicon Labs' }] }] };
    expect(parseSystemProfiler(legacy)[0]).toMatchObject({ vid: '10C4', pid: 'EA60', serialNumber: '0001' });
  });

  it('flags a USB-serial bridge without a port as driver-missing', () => {
    const usb = [
      { name: 'USB Serial', vid: '1A86', pid: '7523', manufacturer: null, serialNumber: null },
      { name: 'CP2102', vid: '10C4', pid: 'EA60', manufacturer: null, serialNumber: '01' },
      { name: 'Keyboard', vid: '05AC', pid: '0250', manufacturer: 'Apple', serialNumber: null },
      { name: 'RP2 Boot', vid: '2E8A', pid: '0003', manufacturer: null, serialNumber: null },
    ];
    const ports = [{ path: '/dev/cu.usbserial-01', vendorId: '10c4', productId: 'ea60', serialNumber: '01' }];
    const r = buildDriverReports(usb, ports, 'darwin');
    expect(r.map((d) => [d.chip, d.driverState, d.serialPorts])).toEqual([
      ['CH340', 'missing', []],
      ['CP2102/CP2104', 'ok', ['/dev/cu.usbserial-01']],
      ['RP2040 BOOTSEL', 'not-required', []],
    ]);
    expect(r[0]!.driver.downloadUrl).toMatch(/^https:\/\/www\.wch-ic\.com/);
  });

  it('parses Windows PnP output including problem devices', () => {
    const r = parseWindowsPnp([
      { FriendlyName: 'USB-SERIAL CH340 (COM5)', InstanceId: 'USB\\VID_1A86&PID_7523\\5&1A2B', Status: 'OK', Class: 'Ports', Manufacturer: 'wch.cn' },
      { FriendlyName: 'USB Serial', InstanceId: 'USB\\VID_10C4&PID_EA60\\0001', Status: 'Error', Class: null, Manufacturer: null },
    ]);
    expect(r[0]).toMatchObject({ vid: '1A86', pid: '7523', ports: ['COM5'], problem: false });
    expect(r[1]).toMatchObject({ vid: '10C4', serialNumber: '0001', problem: true });
    expect(buildDriverReports(r, [], 'win32').map((d) => d.driverState)).toEqual(['ok', 'missing']);
  });

  it('parses lsof holders', () => {
    expect(parseLsof('p123\ncscreen\np456\ncarduino-cli\n')).toEqual(['screen (123)', 'arduino-cli (456)']);
  });
});
