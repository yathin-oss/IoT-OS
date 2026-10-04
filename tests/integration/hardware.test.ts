import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApi } from '../../src/main/api';
import { createServices } from '../../src/main/services';

/**
 * REAL HARDWARE end-to-end test. Skipped unless explicitly enabled:
 *
 *   IOTOS_HW_TESTS=1 IOTOS_HW_PORT=/dev/cu.usbserial-0001 IOTOS_HW_BOARD=esp32-devkit-v1 npm run test:hw
 *
 * Uses the real arduino-cli, real serial bindings and the connected board:
 * create blink project -> build -> flash -> read "IoT-OS blink started" over serial.
 * Requires the board package for IOTOS_HW_BOARD to be installed.
 */
const enabled = process.env['IOTOS_HW_TESTS'] === '1' && !!process.env['IOTOS_HW_PORT'];

describe.skipIf(!enabled)('physical board end-to-end', () => {
  it('builds, flashes and reads serial output from a real board', { timeout: 15 * 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iotos-hw-'));
    const port = process.env['IOTOS_HW_PORT']!;
    const boardId = process.env['IOTOS_HW_BOARD'] ?? 'esp32-devkit-v1';
    const services = createServices({
      dataDir: join(dir, 'data'),
      defaultWorkspaceDir: join(dir, 'projects'),
      runtime: { kind: 'browser-host', version: process.versions.node, electronVersion: null },
      startDevicePolling: false,
    });
    const api = createApi(services, {
      info: () => ({ version: 'hw-test', runtime: 'browser-host', platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, electronVersion: null, canPickDirectories: false }),
      pickDirectory: async () => null,
      openExternal: async () => undefined,
    });
    const call = async (m: string, a?: unknown) => {
      const r = await api.call(m, a);
      if (!r.ok) throw new Error(`${m}: ${r.error.message}`);
      return r.result as Record<string, unknown>;
    };
    try {
      await call('project.create', { name: 'HW Blink', boardId, language: 'arduino-cpp', template: 'blink' });
      const build = await call('build.run');
      expect(build['status'], String(build['message'])).toBe('succeeded');
      const devices = (await call('devices.refresh')) as unknown as { port: string }[];
      expect(devices.map((d) => d.port)).toContain(port);
      let flash = await call('flash.run', { port });
      if (flash['status'] === 'needs-confirmation') {
        const ids = (flash['checks'] as { id: string; confirmable: boolean }[]).filter((c) => c.confirmable).map((c) => c.id);
        flash = await call('flash.run', { port, confirmed: ids });
      }
      expect(flash['status'], String(flash['message'])).toBe('succeeded');
      await call('serial.open', { port, baud: 115200 });
      const deadline = Date.now() + 15_000;
      let text = '';
      while (Date.now() < deadline) {
        text = ((await call('serial.history', { limit: 200 })) as unknown as { text: string }[]).map((l) => l.text).join('\n');
        if (/LED (on|off)/.test(text)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(text).toMatch(/LED (on|off)/);
    } finally {
      await services.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
