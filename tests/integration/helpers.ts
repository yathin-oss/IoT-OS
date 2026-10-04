import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockBinding } from '@serialport/binding-mock';
import { createApi } from '../../src/main/api';
import { createServices, type ServiceOptions } from '../../src/main/services';
import type { SerialBinding } from '../../src/main/serial/serialManager';
import type { ApiArgs, ApiMethod, ApiResult } from '../../src/core/ipc/contract';

export const FAKE_ARDUINO_CLI = fileURLToPath(new URL('../fixtures/fake-arduino-cli.mjs', import.meta.url));
chmodSync(FAKE_ARDUINO_CLI, 0o755);

export function tempDir(prefix = 'iotos-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Services wired with test doubles: MockBinding serial ports, no USB enumeration,
 * no device polling, no AI keys from the environment, and optionally the fake
 * arduino-cli configured as the arduino-cli tool path.
 */
export function testServices(opts: Partial<ServiceOptions> & { fakeArduino?: boolean } = {}) {
  const { dir, cleanup } = tempDir();
  MockBinding.reset();
  const services = createServices({
    dataDir: join(dir, 'data'),
    defaultWorkspaceDir: join(dir, 'projects'),
    runtime: { kind: 'browser-host', version: process.versions.node, electronVersion: null },
    serialBinding: MockBinding as unknown as SerialBinding,
    portLister: { list: () => MockBinding.list() },
    usbEnumerator: null,
    startDevicePolling: false,
    env: { PATH: process.env['PATH'] ?? '' },
    logLevel: 'warn',
    ...opts,
  });
  if (opts.fakeArduino) services.settings.update({ toolPaths: { 'arduino-cli': FAKE_ARDUINO_CLI } });
  const api = createApi(services, {
    info: () => ({ version: 'test', runtime: 'browser-host', platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, electronVersion: null, canPickDirectories: false }),
    pickDirectory: async () => null,
    openExternal: async () => undefined,
  });
  async function call<K extends ApiMethod>(method: K, args?: ApiArgs<K>): Promise<ApiResult<K>> {
    const r = await api.call(method, args);
    if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code, hint: r.error.hint });
    return r.result as ApiResult<K>;
  }
  return {
    dir,
    services,
    api,
    call,
    async dispose() {
      await services.dispose();
      cleanup();
    },
  };
}
